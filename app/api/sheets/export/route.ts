import { NextResponse } from "next/server";
import { createSpreadsheetFromTemplate, upsertCells, executeGASForFormatting } from "@/lib/googleSheets";
import { extractTitles, extractSectionBody, splitScriptBySections, extractSpreadsheetTitle } from "@/lib/chatExtract";
import { generateCompanyInfo, extractCompanyBasicInfo, type CompanyInfo } from "@/lib/companyExtract";
import type { MembersMessage } from "@/lib/membersApi";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { chatMessages: MembersMessage[]; generatedScript: string };
    const { chatMessages, generatedScript } = body || {};

    const templateFileId = process.env.SHEETS_TEMPLATE_FILE_ID || "";
    if (!templateFileId) return NextResponse.json({ ok: false, error: "SHEETS_TEMPLATE_FILE_ID が未設定" }, { status: 400 });
    if (!Array.isArray(chatMessages) || chatMessages.length === 0) return NextResponse.json({ ok: false, error: "chatMessages が空" }, { status: 400 });
    if (!generatedScript) return NextResponse.json({ ok: false, error: "generatedScript が空" }, { status: 400 });

    const { basicInfoTitle, listInfoTitle } = extractTitles(chatMessages);
    const spreadsheetTitle = extractSpreadsheetTitle(chatMessages);
    

    const { spreadsheetId } = await createSpreadsheetFromTemplate({
      templateFileId,
      title: spreadsheetTitle,
      firstSheetTitle: listInfoTitle,
      setEditorPermission: true,
    });

    // GASを2分後に実行してキーワードの文字色を変更
    try {
      console.log("Scheduling GAS execution for 2 minutes later");
      // 非同期で2分後にGASを実行（ブロックしない）
      setTimeout(async () => {
        try {
          await executeGASForFormatting(spreadsheetId, 0); // 遅延は既に設定済みなので0
          console.log("GAS formatting completed successfully (delayed execution)");
        } catch (error) {
          console.error("Delayed GAS formatting failed:", error);
        }
      }, 2 * 60 * 1000); // 2分 = 2 * 60 * 1000ms
      
      console.log("GAS execution scheduled for 2 minutes later");
    } catch (error) {
      console.error("GAS scheduling failed:", error);
      // GASの実行失敗はスプレッドシート作成の失敗とはしない
    }

    const basicBody = extractSectionBody(chatMessages, "■基本情報");
    const urlBody = extractSectionBody(chatMessages, "■企業URL");
    const productBody = extractSectionBody(chatMessages, "■商材情報");
    const closingBody = extractSectionBody(chatMessages, "■トーク情報(着地)") || extractSectionBody(chatMessages, "■トーク情報");
    

    // Split generated script into sections and write into designated cells
    const { plot1, plot2, plot3, plot4, plot5, qa } = splitScriptBySections(generatedScript);

    await upsertCells({
      spreadsheetId,
      sheetTitle: listInfoTitle,
      values: [
        { a1: "C1", value: basicBody },
        { a1: "F3", value: urlBody },
        { a1: "C6", value: productBody },
        { a1: "C13", value: closingBody },
        { a1: "C15", value: plot1 },
        { a1: "C17", value: plot2 },
        { a1: "C19", value: plot3 },
        { a1: "C21", value: plot4 },
        { a1: "C23", value: plot5 },
        { a1: "F17", value: qa },
      ],
    });

    // データ挿入完了後にGASを2分後に実行
    try {
      console.log("Scheduling GAS execution for 2 minutes after data insertion");
      // 非同期で2分後にGASを実行（ブロックしない）
      setTimeout(async () => {
        try {
          await executeGASForFormatting(spreadsheetId, 0);
          console.log("GAS formatting completed successfully (delayed execution)");
        } catch (error) {
          console.error("Delayed GAS formatting failed:", error);
        }
      }, 2 * 60 * 1000); // 2分 = 2 * 60 * 1000ms
      
      console.log("GAS execution scheduled for 2 minutes after data insertion");
    } catch (error) {
      console.error("GAS scheduling failed:", error);
      // GASの実行失敗はスプレッドシート作成の失敗とはしない
    }

    return NextResponse.json({ ok: true, spreadsheetId });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error in /api/sheets/export:", error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}