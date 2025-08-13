import { getRoomMessages, type MembersMessage } from "@/lib/membersApi";
import { generateSalesScriptFromContext } from "@/lib/generator";
import { createSpreadsheetFromTemplate, upsertCells } from "@/lib/googleSheets";
import { extractTitles, extractSectionBody } from "@/lib/chatExtract";

export const runtime = "nodejs";

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

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let isClosed = false;
      let ticker: ReturnType<typeof setInterval> | undefined; // eslint-disable-line prefer-const
      let heartbeat: ReturnType<typeof setInterval> | undefined; // eslint-disable-line prefer-const
      let generating = false;

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
          await upsertCells({ spreadsheetId, sheetTitle: listInfoTitle, values: [
            { a1: "C1", value: basicBody },
            { a1: "F3", value: urlBody },
            { a1: "C6", value: productBody },
            { a1: "C13", value: closingBody },
            { a1: "C15", value: generatedScript },
          ]});
          safeSend({ type: "status", phase: "export_done", spreadsheetId });
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          safeSend({ type: "error", message });
        }
      };

      const runGeneration = async (reuseMessages?: MembersMessage[]) => {
        if (generating) return;
        try {
          generating = true;
          safeSend({ type: "status", phase: "generation_start" });
          const result = await generateSalesScriptFromContext({ roomId, force: 1, useReasoning });
          safeSend({ type: "status", phase: "generation_done", content: result.content, model: result.model, mode: result.mode });
          await runExport(result.content, result.messages);
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          safeSend({ type: "error", message });
        } finally {
          generating = false;
        }
      };

      const poll = async () => {
        try {
          const token = process.env.MEMBERS_token ?? process.env.MEMBERS_TOKEN;
          const ms = await getRoomMessages(roomId, { force: 1, token });
          if (ms.length > 0) {
            safeSend({ type: "messages", messages: ms });
            const latestId = ms[ms.length - 1].message_id;
            if (latestId > lastSeenId) {
              lastSeenId = latestId;
              safeSend({ type: "status", phase: "poll_ok" });
              await runGeneration(ms);
            }
          }
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          safeSend({ type: "error", message });
        }
      };

      safeSend({ type: "hello", roomId, intervalMs });
      heartbeat = setInterval(() => safeSend({ type: "ping", t: Date.now() }), 25000);
      ticker = setInterval(poll, intervalMs);
      void poll();

      if (generateOnConnect) void runGeneration();
      const abortHandler = () => cleanup();
      request.signal?.addEventListener("abort", abortHandler, { once: true });
    },
    cancel() {},
  });

  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
} 