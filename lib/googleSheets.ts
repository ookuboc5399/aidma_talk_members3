import { google, sheets_v4, drive_v3, Auth } from "googleapis";

function getAuth(): Auth.GoogleAuth {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
    return new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON),
      scopes: [
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/spreadsheets",
      ],
    });
  } else {
    // ローカル開発環境など、GOOGLE_APPLICATION_CREDENTIALS_JSON が設定されていない場合
    return new google.auth.GoogleAuth({
      scopes: [
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/spreadsheets",
      ],
    });
  }
}

function quoteSheetForA1(title: string): string {
  const escaped = title.replace(/'/g, "''");
  return `'${escaped}'`;
}

export async function createSpreadsheetFromTemplate(params: { templateFileId: string; title: string; firstSheetTitle: string; }): Promise<{ spreadsheetId: string }>{
  const authClient = await getAuth().getClient() as Auth.OAuth2Client;
  const drive = google.drive({ version: "v3", auth: authClient }) as drive_v3.Drive;
  const sheets = google.sheets({ version: "v4", auth: authClient }) as sheets_v4.Sheets;

  const destinationFolderId = process.env.GOOGLE_DRIVE_DESTINATION_FOLDER_ID;
  const copyRes = await drive.files.copy({
    fileId: params.templateFileId,
    supportsAllDrives: true,
    requestBody: { name: params.title, parents: destinationFolderId ? [destinationFolderId] : undefined },
  });
  const newFileId = copyRes.data.id;
  if (!newFileId) throw new Error("テンプレートの複製に失敗しました（新ファイルIDなし）");

  const ss = await sheets.spreadsheets.get({ spreadsheetId: newFileId });
  const firstSheet = ss.data.sheets?.[0];
  const firstSheetId = firstSheet?.properties?.sheetId;
  if (firstSheetId == null) throw new Error("スプレッドシートの最初のシートIDを取得できませんでした。");

  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: newFileId,
      requestBody: { requests: [{ updateSheetProperties: { properties: { sheetId: firstSheetId, title: params.firstSheetTitle }, fields: "title" } }] },
    });
  } catch {}

  return { spreadsheetId: newFileId };
}

export async function upsertCells(params: { spreadsheetId: string; sheetTitle: string; values: { a1: string; value: string }[]; }): Promise<void> {
  const authClient = await getAuth().getClient() as Auth.OAuth2Client;
  const sheets = google.sheets({ version: "v4", auth: authClient }) as sheets_v4.Sheets;

  const data = params.values.map(v => ({ range: `${quoteSheetForA1(params.sheetTitle)}!${v.a1}`, values: [[v.value]] }));
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: params.spreadsheetId,
    requestBody: { data, valueInputOption: "RAW" },
  });
} 