import { getRoomMessages, type MembersMessage } from "@/lib/membersApi";
import { generateSalesScriptFromContext } from "@/lib/generator";
import { createSpreadsheetFromTemplate, upsertCells, executeGASForFormatting, registerSpreadsheetResult } from "@/lib/googleSheets";
import { extractTitles, extractSectionBody, splitScriptBySections, extractSpreadsheetTitle } from "@/lib/chatExtract";
import { generateCompanyInfo, extractCompanyBasicInfo, type CompanyInfo } from "@/lib/companyExtract";

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
  const roomId = Number(searchParams.get("roomId")) || 199987;
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

      const runExport = async (generatedScript: string, reuseMessages?: MembersMessage[], wasGenerationSuccessful: boolean = false, companyInfo?: CompanyInfo | null, triggeredByMessageId?: number) => {
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

        // basicBody と companyNameForSheet を try ブロックの外に移動
        const basicBody = extractSectionBody(reuseMessages ?? [], "■基本情報");
        const urlBody = extractSectionBody(reuseMessages ?? [], "■企業URL");
        const productBody = extractSectionBody(reuseMessages ?? [], "■商材情報");
        const closingBody = extractSectionBody(reuseMessages ?? [], "■トーク情報(着地)");

        const companyNameMatch = basicBody.match(/会社名：([^\n]*)/);
        let companyNameForSheet = companyNameMatch ? companyNameMatch[1].trim() : "不明";
        if (companyNameForSheet.endsWith("様")) {
          companyNameForSheet = companyNameForSheet.slice(0, -1);
        }
        sendDebug(`companyNameForSheet: ${companyNameForSheet}`); // ★ 追加

        try {
          sendDebug("Starting spreadsheet export for generated script");
          safeSend({ type: "status", phase: "export_start" });
          const { listInfoTitle } = extractTitles(reuseMessages ?? []);
          const spreadsheetTitle = extractSpreadsheetTitle(reuseMessages ?? []);
          const { spreadsheetId } = await createSpreadsheetFromTemplate({ templateFileId, title: spreadsheetTitle, firstSheetTitle: listInfoTitle, setEditorPermission: true });

          // Split the generated script into sections (only if script was generated)
          let plot1 = "", plot2 = "", plot3 = "", plot4 = "", plot5 = "", qa = "";
          if (generatedScript && generatedScript.trim()) {
            const sections = splitScriptBySections(generatedScript);
            plot1 = sections.plot1;
            plot2 = sections.plot2;
            plot3 = sections.plot3;
            plot4 = sections.plot4;
            plot5 = sections.plot5;
            qa = sections.qa;
          }

          // Prepare cell values array
          const cellValues = [
            { a1: "C1", value: companyNameForSheet },
            { a1: "F3", value: urlBody },
            { a1: "C6", value: productBody },
            { a1: "C13", value: closingBody },
            { a1: "C15", value: plot1 }, // Plot 1 to C15
            { a1: "C17", value: plot2 }, // Plot 2 to C17
            { a1: "C19", value: plot3 }, // Plot 3 to C19
            { a1: "C21", value: plot4 }, // Plot 4 to C21
            { a1: "C23", value: plot5 }, // Plot 5 to C23
            { a1: "F17", value: qa }    // Q&A to F17 (プロット⑥)
          ];

          // Add company info if available
          if (companyInfo) {
            sendDebug(`Adding company info to spreadsheet - Business: ${companyInfo.businessContent.substring(0, 50)}...`);
            
            // Override C6 with business content if available
            if (companyInfo.businessContent && companyInfo.businessContent !== "不明") {
              const businessIndex = cellValues.findIndex(cell => cell.a1 === "C6");
              if (businessIndex >= 0) {
                cellValues[businessIndex].value = companyInfo.businessContent;
              }
            }
            
            // Add additional company info
            if (companyInfo.representative && companyInfo.representative !== "不明") {
              cellValues.push({ a1: "C2", value: companyInfo.representative }); // 代表者 → C2
            }
            if (companyInfo.employeeCount && companyInfo.employeeCount !== "不明") {
              cellValues.push({ a1: "C4", value: companyInfo.employeeCount }); // 従業員数 → C4
            }
            if (companyInfo.headOfficeAddress && companyInfo.headOfficeAddress !== "不明") {
              cellValues.push({ a1: "F2", value: companyInfo.headOfficeAddress }); // 本社住所 → F2
            }
          }

          await upsertCells({ spreadsheetId, sheetTitle: listInfoTitle, values: cellValues });
          sendDebug(`Spreadsheet export completed successfully: ${spreadsheetId}`);
          
          // 結果を登録
          try {
            const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
            const resultSheetId = process.env.RESULT_SHEET_ID || "1wqxo6ATm1rsKefu9C-dhLNFe8yRhuBeTMvojta_bRpE";
            
            // トリガーとなったメッセージのsend_timeを取得
            let sendTime: number | undefined;
            if (triggeredByMessageId && reuseMessages) {
              const triggerMessage = reuseMessages.find(msg => msg.message_id === triggeredByMessageId);
              if (triggerMessage && triggerMessage.send_time) {
                sendTime = triggerMessage.send_time;
                sendDebug(`Using send_time from trigger message: ${sendTime}`);
              }
            }
            
            await registerSpreadsheetResult({
              companyName: companyNameForSheet,
              spreadsheetUrl,
              spreadsheetTitle, // ファイル名を渡す
              resultSheetId,
              sendTime,
            });
            
            sendDebug(`Result registered successfully for company: ${companyNameForSheet}`);
          } catch (error) {
            console.error("Result registration failed:", error);
            sendDebug("Result registration failed, but spreadsheet creation is complete");
          }
          
          // データ挿入完了後にGASを2分後に実行
          try {
            sendDebug("Scheduling GAS execution for 2 minutes after data insertion");
            // 非同期で2分後にGASを実行（ブロックしない）
            setTimeout(async () => {
              try {
                await executeGASForFormatting(spreadsheetId, 0);
                sendDebug("GAS formatting completed successfully (delayed execution)");
              } catch (error) {
                console.error("Delayed GAS formatting failed:", error);
                sendDebug("Delayed GAS formatting failed");
              }
            }, 2 * 60 * 1000); // 2分 = 2 * 60 * 1000ms
            
            sendDebug("GAS execution scheduled for 2 minutes after data insertion");
          } catch (error) {
            console.error("GAS scheduling failed:", error);
            sendDebug("GAS scheduling failed, but spreadsheet creation is complete");
          }
          
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
          sendDebug(`Starting parallel generation for room ${roomId}${triggerInfo}`);
          safeSend({ type: "status", phase: "generation_start" });
          
          // Extract company basic info for parallel processing
          const messagesToUse = reuseMessages || await getRoomMessages(roomId, { force: 1 });
          const { companyName, companyUrl } = extractCompanyBasicInfo(messagesToUse);
          sendDebug(`Extracted company info - Name: ${companyName}, URL: ${companyUrl}`);
          
          // Parallel execution of company info and sales script generation
          const [companyInfoResult, salesScriptResult] = await Promise.allSettled([
            generateCompanyInfo(companyName, companyUrl),
            generateSalesScriptFromContext({ 
              roomId, 
              force: 1, 
              useReasoning, 
              targetMessageId: triggeredByMessageId 
            })
          ]);
          
          // Handle company info result
          let companyInfo: CompanyInfo | null = null;
          if (companyInfoResult.status === 'fulfilled') {
            companyInfo = companyInfoResult.value;
            sendDebug(`Company info generation completed successfully`);
          } else {
            sendDebug(`Company info generation failed: ${companyInfoResult.reason}`);
          }
          
          // Handle sales script result
          let salesScriptGenerated = false;
          if (salesScriptResult.status === 'fulfilled') {
            const result = salesScriptResult.value;
            const generationSuccessful = result && result.content && result.content.trim().length > 0;
            
            if (generationSuccessful) {
              sendDebug(`Sales script generation completed successfully. Content length: ${result.content.length}`);
              safeSend({ type: "status", phase: "generation_done", content: result.content, model: result.model, mode: result.mode });
              
              // Update last generation time with current timestamp
              const completionTime = Date.now();
              lastGenerationTime.set(roomId, completionTime);
              sendDebug(`Updated last generation time for room ${roomId}: ${new Date(completionTime).toLocaleTimeString()}`);
              
              // Export with both company info and sales script
              await runExport(result.content, result.messages, true, companyInfo, triggeredByMessageId);
              salesScriptGenerated = true;
            } else {
              sendDebug("Sales script generation failed: empty or invalid content returned");
              safeSend({ type: "error", message: "Sales script generation returned empty content" });
            }
          } else {
            sendDebug(`Sales script generation failed: ${salesScriptResult.reason}`);
            safeSend({ type: "error", message: "Sales script generation failed" });
          }
          
          // If sales script failed but company info succeeded, still export company info
          if (!salesScriptGenerated && companyInfo) {
            sendDebug("Exporting company info only (sales script generation failed)");
            await runExport("", messagesToUse, false, companyInfo, triggeredByMessageId);
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