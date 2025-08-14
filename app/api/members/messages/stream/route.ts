import { getRoomMessages, type MembersMessage } from "@/lib/membersApi";
import { generateSalesScriptFromContext } from "@/lib/generator";
import { createSpreadsheetFromTemplate, upsertCells } from "@/lib/googleSheets";
import { extractTitles, extractSectionBody, splitScriptBySections } from "@/lib/chatExtract";

export const runtime = "nodejs";

// Lock to prevent multiple concurrent generations for the same room
const roomLocks = new Set<number>();

function toSseData(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const intervalMs = Math.max(1000, Number(searchParams.get("intervalMs")) || 10000);
  const roomId = Number(searchParams.get("roomId")) || 196320;
  let lastSeenId = searchParams.get("lastId") ? Number(searchParams.get("lastId")) : 0;
  const useReasoning = searchParams.get("useReasoning") === "1";
  const generateOnConnect = searchParams.get("generateOnConnect") === "1";
  const exportOnGenerate = searchParams.get("exportOnGenerate") === "1";
  const enableDebug = searchParams.get("debug") === "1";

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let isClosed = false;
      let ticker: ReturnType<typeof setInterval> | undefined; // eslint-disable-line prefer-const
      let heartbeat: ReturnType<typeof setInterval> | undefined; // eslint-disable-line prefer-const
      let generating = false;
      let isFirstPoll = true; // Flag to check if it's the first poll

      const cleanup = () => {
        if (ticker) clearInterval(ticker);
        if (heartbeat) clearInterval(heartbeat);
        isClosed = true;
      };

      const safeSend = (payload: unknown) => {
        if (isClosed) return;
        try {
          controller.enqueue(encoder.encode(toSseData(payload)));
        } catch {}
      };

      const sendDebug = (message: string) => {
        if (!enableDebug) return;
        safeSend({ type: "debug", message });
      };

      const runExport = async (generatedScript: string, reuseMessages?: MembersMessage[]) => {
        if (!exportOnGenerate) return;
        const templateFileId = process.env.SHEETS_TEMPLATE_FILE_ID || "";
        if (!templateFileId) return;
        try {
          safeSend({ type: "status", phase: "export_start" });
          const { basicInfoTitle, listInfoTitle } = extractTitles(reuseMessages ?? []);
          const { spreadsheetId } = await createSpreadsheetFromTemplate({ templateFileId, title: basicInfoTitle, firstSheetTitle: listInfoTitle });

          const basicBody = extractSectionBody(reuseMessages ?? [], "■基本情報");
          const urlBody = extractSectionBody(reuseMessages ?? [], "■企業URL");
          const productBody = extractSectionBody(reuseMessages ?? [], "■商材情報");
          const closingBody = extractSectionBody(reuseMessages ?? [], "■トーク情報(着地)");
          
          // Split the generated script into sections
          const { plot1, plot2, qa } = splitScriptBySections(generatedScript);

          await upsertCells({ spreadsheetId, sheetTitle: listInfoTitle, values: [
            { a1: "C1", value: basicBody },
            { a1: "F3", value: urlBody },
            { a1: "C6", value: productBody },
            { a1: "C13", value: closingBody },
            { a1: "C15", value: plot1 }, // Plot 1 to C15
            { a1: "C17", value: plot2 }, // Plot 2 to C17
            { a1: "C19", value: qa },    // Q&A to C19
          ]});
          safeSend({ type: "status", phase: "export_done", spreadsheetId });
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          safeSend({ type: "error", message });
        }
      };

      const runGeneration = async (reuseMessages?: MembersMessage[]) => {
        if (generating) return;
        // Acquire lock for the room
        if (roomLocks.has(roomId)) {
          sendDebug(`Generation for room ${roomId} is already in progress. Skipping.`);
          return;
        }

        try {
          generating = true;
          roomLocks.add(roomId);
          safeSend({ type: "status", phase: "generation_start" });
          const result = await generateSalesScriptFromContext({ roomId, force: 1, useReasoning });
          safeSend({ type: "status", phase: "generation_done", content: result.content, model: result.model, mode: result.mode });
          await runExport(result.content, result.messages);
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          safeSend({ type: "error", message });
        } finally {
          generating = false;
          roomLocks.delete(roomId); // Release lock
        }
      };

      const poll = async () => {
        try {
          sendDebug(`Polling started. Current lastSeenId: ${lastSeenId}`);
          const token = process.env.MEMBERS_token ?? process.env.MEMBERS_TOKEN;
          const ms = await getRoomMessages(roomId, { force: 1, token });
          if (ms.length > 0) {
            safeSend({ type: "messages", messages: ms });
            const latestId = ms[ms.length - 1].message_id;
            sendDebug(`Fetched messages. Latest ID: ${latestId}`);

            // On the first poll, if generateOnConnect is true, run generation.
            if (isFirstPoll && generateOnConnect) {
              sendDebug("First poll with generateOnConnect=true. Running generation.");
              safeSend({ type: "status", phase: "poll_ok" });
              await runGeneration(ms);
              lastSeenId = latestId;
            } else if (latestId > lastSeenId) {
              sendDebug(`New message found (latestId: ${latestId} > lastSeenId: ${lastSeenId}). Running generation.`);
              // On subsequent polls, run generation only if there are new messages.
              lastSeenId = latestId;
              safeSend({ type: "status", phase: "poll_ok" });
              await runGeneration(ms);
            } else {
              sendDebug(`No new messages found (latestId: ${latestId} <= lastSeenId: ${lastSeenId}). Skipping generation.`);
            }
          } else {
            sendDebug("No messages returned from API.");
          }
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          safeSend({ type: "error", message });
        } finally {
          isFirstPoll = false; // Unset the flag after the first poll
        }
      };

      safeSend({ type: "hello", roomId, intervalMs });
      heartbeat = setInterval(() => safeSend({ type: "ping", t: Date.now() }), 25000);
      ticker = setInterval(poll, intervalMs);
      void poll();

      const abortHandler = () => cleanup();
      request.signal?.addEventListener("abort", abortHandler, { once: true });
    },
    cancel() {},
  });

  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
} 