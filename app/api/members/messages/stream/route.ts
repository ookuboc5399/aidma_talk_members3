import { getRoomMessages, type MembersMessage } from "@/lib/membersApi";
import { generateSalesScriptFromContext } from "@/lib/generator";
import { createSpreadsheetFromTemplate, upsertCells } from "@/lib/googleSheets";
import { extractTitles, extractSectionBody, splitScriptBySections } from "@/lib/chatExtract";

export const runtime = "nodejs";

// Lock to prevent multiple concurrent generations for the same room
const roomLocks = new Set<number>();

// Track last generation time for each room (5 minute minimum interval)
const lastGenerationTime = new Map<number, number>();
const MIN_GENERATION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Queue for pending messages that need to wait for the interval
const pendingMessages = new Map<number, { messageId: number; scheduledTime: number }[]>();

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

      const runExport = async (generatedScript: string, reuseMessages?: MembersMessage[], wasGenerationSuccessful: boolean = false) => {
        // 厳格な条件チェック
        if (!exportOnGenerate) {
          sendDebug("Export skipped: exportOnGenerate is false");
          return;
        }
        if (!wasGenerationSuccessful) {
          sendDebug("Export skipped: generation was not successful");
          return;
        }
        if (!generatedScript || generatedScript.trim().length === 0) {
          sendDebug("Export skipped: generated script is empty");
          return;
        }
        
        const templateFileId = process.env.SHEETS_TEMPLATE_FILE_ID || "";
        if (!templateFileId) {
          sendDebug("Export skipped: SHEETS_TEMPLATE_FILE_ID not configured");
          return;
        }
        
        try {
          sendDebug("Starting spreadsheet export for generated script");
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
          sendDebug(`Spreadsheet export completed successfully: ${spreadsheetId}`);
          safeSend({ type: "status", phase: "export_done", spreadsheetId });
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          sendDebug(`Spreadsheet export failed: ${message}`);
          safeSend({ type: "error", message });
        }
      };

      const runGeneration = async (reuseMessages?: MembersMessage[], triggeredByMessageId?: number) => {
        if (generating) return;
        
        // Check minimum interval (5 minutes)
        const now = Date.now();
        const lastTime = lastGenerationTime.get(roomId) || 0;
        const timeSinceLastGeneration = now - lastTime;
        
        sendDebug(`Interval check - Room: ${roomId}, Last: ${new Date(lastTime).toLocaleTimeString()}, Now: ${new Date(now).toLocaleTimeString()}, Since: ${Math.floor(timeSinceLastGeneration/60000)}min`);
        
        if (timeSinceLastGeneration < MIN_GENERATION_INTERVAL_MS) {
          const remainingMs = MIN_GENERATION_INTERVAL_MS - timeSinceLastGeneration;
          const remainingMinutes = Math.ceil(remainingMs / 60000);
          const scheduledTime = lastTime + MIN_GENERATION_INTERVAL_MS;
          
          // Add to pending queue if not already queued
          if (triggeredByMessageId) {
            const roomQueue = pendingMessages.get(roomId) || [];
            const alreadyQueued = roomQueue.some(item => item.messageId === triggeredByMessageId);
            
            if (!alreadyQueued) {
              roomQueue.push({ messageId: triggeredByMessageId, scheduledTime });
              pendingMessages.set(roomId, roomQueue);
              sendDebug(`Message ${triggeredByMessageId} queued for processing at ${new Date(scheduledTime).toLocaleTimeString()}`);
            } else {
              sendDebug(`Message ${triggeredByMessageId} already in queue`);
            }
          }
          
          sendDebug(`Generation skipped: minimum 5-minute interval not met. Wait ${remainingMinutes} more minutes.`);
          return;
        }
        
        // Acquire lock for the room
        if (roomLocks.has(roomId)) {
          sendDebug(`Generation for room ${roomId} is already in progress. Skipping.`);
          return;
        }

        try {
          generating = true;
          roomLocks.add(roomId);
          const triggerInfo = triggeredByMessageId ? ` (triggered by message ID: ${triggeredByMessageId})` : "";
          sendDebug(`Starting generation for room ${roomId}${triggerInfo}`);
          safeSend({ type: "status", phase: "generation_start" });
          
          const result = await generateSalesScriptFromContext({ 
            roomId, 
            force: 1, 
            useReasoning, 
            targetMessageId: triggeredByMessageId 
          });
          
          // Check if generation was successful
          const generationSuccessful = result && result.content && result.content.trim().length > 0;
          
          if (generationSuccessful) {
            sendDebug(`Generation completed successfully. Content length: ${result.content.length}`);
            safeSend({ type: "status", phase: "generation_done", content: result.content, model: result.model, mode: result.mode });
            
            // Update last generation time with current timestamp
            const completionTime = Date.now();
            lastGenerationTime.set(roomId, completionTime);
            sendDebug(`Updated last generation time for room ${roomId}: ${new Date(completionTime).toLocaleTimeString()}`);
            
            // Only export if generation was successful
            await runExport(result.content, result.messages, true);
          } else {
            sendDebug("Generation failed: empty or invalid content returned");
            safeSend({ type: "error", message: "Generation returned empty content" });
          }
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          sendDebug(`Generation failed with error: ${message}`);
          safeSend({ type: "error", message });
          // Do not call runExport on error
        } finally {
          generating = false;
          roomLocks.delete(roomId); // Release lock
        }
      };

      const checkPendingQueue = async (allMessages: MembersMessage[]) => {
        const roomQueue = pendingMessages.get(roomId) || [];
        const now = Date.now();
        const readyMessages = roomQueue.filter(item => now >= item.scheduledTime);
        
        if (readyMessages.length > 0) {
          sendDebug(`Found ${readyMessages.length} messages ready for processing from queue`);
          
          for (const item of readyMessages) {
            sendDebug(`Processing queued message ${item.messageId} (scheduled for ${new Date(item.scheduledTime).toLocaleTimeString()})`);
            await runGeneration(allMessages, item.messageId);
            
            // Remove from queue after processing
            const updatedQueue = roomQueue.filter(q => q.messageId !== item.messageId);
            pendingMessages.set(roomId, updatedQueue);
          }
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

            // On the first poll
            if (isFirstPoll) {
              if (generateOnConnect) {
                sendDebug("First poll with generateOnConnect=true. Running generation.");
                safeSend({ type: "status", phase: "poll_ok" });
                await runGeneration(ms);
              } else {
                sendDebug("First poll with generateOnConnect=false. Marking all existing messages as processed.");
              }
              // Mark all existing messages as processed
              lastSeenId = latestId;
            } else if (latestId > lastSeenId) {
              // Find all unprocessed messages (only for subsequent polls)
              const unprocessedMessages = ms.filter(m => m.message_id > lastSeenId);
              sendDebug(`Found ${unprocessedMessages.length} unprocessed messages (IDs: ${unprocessedMessages.map(m => m.message_id).join(', ')})`);
              
              // Process each unprocessed message
              for (const msg of unprocessedMessages) {
                sendDebug(`Processing message ID: ${msg.message_id} - Content preview: ${msg.body.substring(0, 100).replace(/<[^>]+>/g, ' ')}`);
                safeSend({ type: "status", phase: "poll_ok" });
                await runGeneration(ms, msg.message_id); // Use all messages for context, but triggered by this specific message
                lastSeenId = msg.message_id; // Update after each successful generation
                sendDebug(`Updated lastSeenId to: ${lastSeenId}`);
              }
            } else {
              sendDebug(`No new messages found (latestId: ${latestId} <= lastSeenId: ${lastSeenId}). Skipping generation.`);
            }
            
            // Always check pending queue regardless of new messages
            await checkPendingQueue(ms);
          } else {
            sendDebug("No messages returned from API.");
            // Still check pending queue even if no messages
            await checkPendingQueue([]);
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