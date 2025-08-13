import { NextResponse } from "next/server";
import { createSpreadsheetFromTemplate, upsertCells } from "@/lib/googleSheets";
import { extractTitles, extractSectionBody } from "@/lib/chatExtract";
import type { MembersMessage } from "@/lib/membersApi";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { chatMessages: MembersMessage[]; generatedScript: string };
    const { chatMessages, generatedScript } = body || {};
    console.log("--- chatMessages ---");
    console.log(JSON.stringify(chatMessages, null, 2));
    console.log("--- generatedScript ---");
    console.log(generatedScript);

    const templateFileId = process.env.SHEETS_TEMPLATE_FILE_ID || "";
    if (!templateFileId) return NextResponse.json({ ok: false, error: "SHEETS_TEMPLATE_FILE_ID が未設定" }, { status: 400 });
    if (!Array.isArray(chatMessages) || chatMessages.length === 0) return NextResponse.json({ ok: false, error: "chatMessages が空" }, { status: 400 });
    if (!generatedScript) return NextResponse.json({ ok: false, error: "generatedScript が空" }, { status: 400 });

    const { basicInfoTitle, listInfoTitle } = extractTitles(chatMessages);
    console.log("--- extracted titles ---");
    console.log("basicInfoTitle:", basicInfoTitle);
    console.log("listInfoTitle:", listInfoTitle);

    const { spreadsheetId } = await createSpreadsheetFromTemplate({
      templateFileId,
      title: basicInfoTitle,
      firstSheetTitle: listInfoTitle,
    });

    const basicBody = extractSectionBody(chatMessages, "■基本情報");
    const urlBody = extractSectionBody(chatMessages, "■企業URL");
    const productBody = extractSectionBody(chatMessages, "■商材情報");
    const closingBody = extractSectionBody(chatMessages, "■トーク情報(着地)");
    console.log("--- extracted bodies ---");
    console.log("basicBody:", basicBody);
    console.log("urlBody:", urlBody);
    console.log("productBody:", productBody);
    console.log("closingBody:", closingBody);

    await upsertCells({
      spreadsheetId,
      sheetTitle: listInfoTitle,
      values: [
        { a1: "C1", value: basicBody },
        { a1: "F3", value: urlBody },
        { a1: "C6", value: productBody },
        { a1: "C13", value: closingBody },
        { a1: "C15", value: generatedScript },
      ],
    });

    return NextResponse.json({ ok: true, spreadsheetId });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error in /api/sheets/export:", error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}