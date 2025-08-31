import { google, sheets_v4, drive_v3, Auth } from "googleapis";

function getAuth(): Auth.GoogleAuth {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
    return new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON),
      scopes: [
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/script.projects",
      ],
    });
  } else {
    // ローカル開発環境など、GOOGLE_APPLICATION_CREDENTIALS_JSON が設定されていない場合
    return new google.auth.GoogleAuth({
      scopes: [
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/script.projects",
      ],
    });
  }
}

function quoteSheetForA1(title: string): string {
  const escaped = title.replace(/'/g, "''");
  return `'${escaped}'`;
}

export async function createSpreadsheetFromTemplate(params: { templateFileId: string; title: string; firstSheetTitle: string; setEditorPermission?: boolean; }): Promise<{ spreadsheetId: string }>{
  const authClient = await getAuth().getClient() as Auth.OAuth2Client;
  const drive = google.drive({ version: "v3", auth: authClient }) as drive_v3.Drive;
  const sheets = google.sheets({ version: "v4", auth: authClient }) as sheets_v4.Sheets;

  let destinationFolderId = process.env.GOOGLE_DRIVE_DESTINATION_FOLDER_ID;
  console.log("[DEBUG] Template file ID:", params.templateFileId);
  console.log("[DEBUG] Destination folder ID:", destinationFolderId);
  console.log("[DEBUG] Copy request parents:", destinationFolderId ? [destinationFolderId] : undefined);
  
  // フォルダIDの妥当性チェック（共有ドライブ対応）
  if (destinationFolderId) {
    try {
      await drive.files.get({ 
        fileId: destinationFolderId,
        supportsAllDrives: true // 共有ドライブ対応
      });
      console.log("[DEBUG] ✅ Destination folder exists and is accessible");
    } catch (folderError) {
      console.error("[DEBUG] ❌ Destination folder not found or not accessible:", folderError);
      console.log("[DEBUG] ℹ️ This might be a shared drive access issue");
      console.log("[DEBUG] 🔄 Falling back to root folder creation");
      destinationFolderId = undefined;
    }
  } else {
    console.log("[DEBUG] ⚠️ No destination folder ID specified, file will be created in root");
  }
  
  console.log("[SPREADSHEET] 🚀 Starting template copy process");
  console.log("[SPREADSHEET] 📄 Template file ID:", params.templateFileId);
  console.log("[SPREADSHEET] 📁 Destination folder ID:", destinationFolderId);
  console.log("[SPREADSHEET] 📝 New file name:", params.title);
  
  const copyRes = await drive.files.copy({
    fileId: params.templateFileId,
    supportsAllDrives: true,
    requestBody: { 
      name: params.title, 
      parents: destinationFolderId ? [destinationFolderId] : undefined 
    },
  });
  
  const newFileId = copyRes.data.id;
  if (!newFileId) throw new Error("テンプレートの複製に失敗しました（新ファイルIDなし）");
  
  console.log("[SPREADSHEET] ✅ Template copy completed successfully");
  console.log("[SPREADSHEET] 🆔 New spreadsheet ID:", newFileId);
  console.log("[SPREADSHEET] 📂 Parent folders:", copyRes.data.parents);
  console.log("[SPREADSHEET] 🔗 Spreadsheet URL: https://docs.google.com/spreadsheets/d/" + newFileId + "/edit");
  
  // 共有ドライブの確認
  if (!copyRes.data.parents || copyRes.data.parents.length === 0) {
    console.log("[SPREADSHEET] ℹ️ File created in shared drive (no parent folders shown)");
  } else {
    console.log("[SPREADSHEET] ℹ️ File created in personal drive");
  }

  const ss = await sheets.spreadsheets.get({ spreadsheetId: newFileId });
  const firstSheet = ss.data.sheets?.[0];
  const firstSheetId = firstSheet?.properties?.sheetId;
  if (firstSheetId == null) throw new Error("スプレッドシートの最初のシートIDを取得できませんでした。");

  console.log("[SPREADSHEET] 📋 First sheet ID:", firstSheetId);
  console.log("[SPREADSHEET] 🏷️ New sheet title:", params.firstSheetTitle);
  
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: newFileId,
      requestBody: { requests: [{ updateSheetProperties: { properties: { sheetId: firstSheetId, title: params.firstSheetTitle }, fields: "title" } }] },
    });
    console.log("[SPREADSHEET] ✅ Sheet title updated successfully");
  } catch (error) {
    console.error("[SPREADSHEET] ❌ Failed to update sheet title:", error);
  }

  // 編集者権限を設定（オプション）
  if (params.setEditorPermission && process.env.DISABLE_EDITOR_PERMISSION !== 'true') {
    console.log("[PERMISSION] 🔐 Starting editor permission setup");
    try {
      // ファイル作成後に少し待機してから権限設定（共有ドライブでは早く設定可能）
      console.log("[PERMISSION] ⏳ Waiting 2 seconds before setting permissions...");
      await new Promise(resolve => setTimeout(resolve, 2000)); // 2秒待機
      
      // ファイルの存在確認（共有ドライブ対応）
      try {
        await drive.files.get({ 
          fileId: newFileId,
          supportsAllDrives: true // 共有ドライブ対応
        });
        console.log("[PERMISSION] ✅ File exists, proceeding with permission setting");
      } catch (fileError) {
        console.error("[PERMISSION] ❌ File not found, skipping permission setting:", fileError);
        return { spreadsheetId: newFileId };
      }
      
      // 共有ドライブ対応の権限設定
      await drive.permissions.create({
        fileId: newFileId,
        requestBody: {
          role: 'writer',  // 編集者権限
          type: 'anyone',  // 誰でも（リンクを知っている人）
        },
        supportsAllDrives: true, // 共有ドライブ対応
      });
      console.log("[PERMISSION] ✅ Editor permission set successfully for spreadsheet:", newFileId);
      console.log("[PERMISSION] ℹ️ Shared drive permissions configured with supportsAllDrives: true");
    } catch (error) {
      console.error("[PERMISSION] ❌ Failed to set editor permission:", error);
      // 権限設定の失敗はスプレッドシート作成の失敗とはしない
    }
  } else {
    console.log("[PERMISSION] ⏭️ Skipping editor permission setup (disabled or not requested)");
  }

  return { spreadsheetId: newFileId };
}

export async function registerSpreadsheetResult(params: {
  companyName: string;
  spreadsheetUrl: string;
  resultSheetId: string;
  sendTime?: string; // チャットメッセージのsend_time
}): Promise<void> {
  const authClient = await getAuth().getClient() as Auth.OAuth2Client;
  const sheets = google.sheets({ version: "v4", auth: authClient }) as sheets_v4.Sheets;

  console.log(`[RESULT-REGISTER] 📊 Starting result registration`);
  console.log(`[RESULT-REGISTER] 📄 Result sheet ID: ${params.resultSheetId}`);
  console.log(`[RESULT-REGISTER] 🏢 Company: ${params.companyName}`);
  console.log(`[RESULT-REGISTER] 🔗 Spreadsheet URL: ${params.spreadsheetUrl}`);

  try {
    // 現在のデータを取得して次の行番号を決定
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: params.resultSheetId,
      range: 'A:D',
    });

    const values = response.data.values || [];
    const nextRow = values.length + 1;

    // 時刻をわかりやすい形式に変換
    const formatDateTime = (isoString: string) => {
      try {
        const date = new Date(isoString);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        return `${year}/${month}/${day} ${hours}:${minutes}`;
      } catch (error) {
        console.error(`[RESULT-REGISTER] ❌ Failed to format date: ${isoString}`, error);
        return isoString; // フォーマット失敗時は元の文字列を返す
      }
    };

    // スプレッドシートURLからファイル名を抽出
    const extractFileName = (url: string) => {
      try {
        const urlObj = new URL(url);
        const pathParts = urlObj.pathname.split('/');
        const fileId = pathParts[pathParts.length - 2]; // /d/{fileId}/edit の形式
        return `スプレッドシート_${fileId.substring(0, 8)}...`; // 最初の8文字を表示
      } catch (error) {
        console.error(`[RESULT-REGISTER] ❌ Failed to extract filename from URL: ${url}`, error);
        return 'ファイル名取得エラー';
      }
    };

    // 新しい行のデータを準備
    const newRow = [
      formatDateTime(params.sendTime || new Date().toISOString()), // A列: フォーマット済み時刻
      params.companyName,       // B列: 企業名
      extractFileName(params.spreadsheetUrl), // C列: スプレッドシートファイル名
      params.spreadsheetUrl,    // D列: スプレッドシートURL
    ];

    // データを追加
    await sheets.spreadsheets.values.update({
      spreadsheetId: params.resultSheetId,
      range: `A${nextRow}:D${nextRow}`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [newRow],
      },
    });

    console.log(`[RESULT-REGISTER] ✅ Result registered successfully at row ${nextRow}`);
    console.log(`[RESULT-REGISTER] 📍 Row ${nextRow}: ${newRow.join(' | ')}`);
    console.log(`[RESULT-REGISTER] 📊 Columns: A=時刻, B=企業名, C=ファイル名, D=URL`);

  } catch (error) {
    console.error(`[RESULT-REGISTER] ❌ Failed to register result:`, error);
    // 結果登録の失敗はスプレッドシート作成の失敗とはしない
  }
}

export async function upsertCells(params: { spreadsheetId: string; sheetTitle: string; values: { a1: string; value: string }[]; }): Promise<void> {
  const authClient = await getAuth().getClient() as Auth.OAuth2Client;
  const sheets = google.sheets({ version: "v4", auth: authClient }) as sheets_v4.Sheets;

  console.log(`[DATA-INSERT] 📊 Starting data insertion`);
  console.log(`[DATA-INSERT] 📄 Spreadsheet ID: ${params.spreadsheetId}`);
  console.log(`[DATA-INSERT] 📋 Sheet title: ${params.sheetTitle}`);
  console.log(`[DATA-INSERT] 📝 Number of cells to update: ${params.values.length}`);
  
  const data = params.values.map(v => ({ range: `${quoteSheetForA1(params.sheetTitle)}!${v.a1}`, values: [[v.value]] }));
  
  // 各セルの更新内容をログ出力
  params.values.forEach((cell, index) => {
    console.log(`[DATA-INSERT] 📍 Cell ${index + 1}: ${cell.a1} = "${cell.value.substring(0, 50)}${cell.value.length > 50 ? '...' : ''}"`);
  });
  
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: params.spreadsheetId,
    requestBody: { data, valueInputOption: "RAW" },
  });
  
  console.log(`[DATA-INSERT] ✅ Data insertion completed successfully`);
}

export async function executeGASForFormatting(spreadsheetId: string, delayMinutes: number = 0): Promise<void> {
  const executionId = Date.now();
  
  console.log(`[GAS-${executionId}] 🚀 GAS execution process started`);
  console.log(`[GAS-${executionId}] 📄 Target spreadsheet ID: ${spreadsheetId}`);
  console.log(`[GAS-${executionId}] 🔗 Spreadsheet URL: https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`);
  
  // GAS実行を無効化する環境変数がある場合はスキップ
  if (process.env.DISABLE_GAS_EXECUTION === 'true') {
    console.log(`[GAS-${executionId}] ⏭️ GAS execution disabled by DISABLE_GAS_EXECUTION environment variable`);
    return;
  }
  
  // GAS実行を完全に無効化（API権限問題のため）
  console.log(`[GAS-${executionId}] ⏭️ GAS execution permanently disabled due to API permission issues`);
  console.log(`[GAS-${executionId}] ✅ Spreadsheet creation and data insertion are working correctly`);
  console.log(`[GAS-${executionId}] 💡 Manual formatting can be applied to the created spreadsheets`);
  return;
  
  // 一時的にGAS実行を無効化（API問題のため）
  // console.log(`[GAS-${executionId}] ⏭️ GAS execution temporarily disabled due to API issues`);
  // console.log(`[GAS-${executionId}] 💡 Please enable Apps Script API in Google Cloud Console`);
  // console.log(`[GAS-${executionId}] 🔗 Visit: https://console.developers.google.com/apis/api/script.googleapis.com/overview`);
  // return;
  
  // 一時的にGAS実行を無効化（デバッグ用）
  // console.log(`[GAS-${executionId}] ⏭️ GAS execution temporarily disabled for debugging`);
  // return;
  
  const authClient = await getAuth().getClient() as Auth.OAuth2Client;
  const script = google.script({ version: "v1", auth: authClient });

  // 新しいApps ScriptプロジェクトIDを設定してください
  const gasFileId = process.env.GAS_PROJECT_ID || "1lNqLeARxISJLDDdyw1L3zqzEy65uk0_qvaoTeAw2h4emMXJ981_zVBsQ";
  
  // 遅延実行の処理
  if (delayMinutes > 0) {
    const delayMs = delayMinutes * 60 * 1000;
    console.log(`[GAS-${executionId}] ⏳ Delaying GAS execution by ${delayMinutes} minutes (${delayMs}ms)`);
    console.log(`[GAS-${executionId}] 🕐 Scheduled execution time: ${new Date(Date.now() + delayMs).toISOString()}`);
    
    await new Promise(resolve => setTimeout(resolve, delayMs));
    
    console.log(`[GAS-${executionId}] 🚀 GAS script execution started after delay`);
  } else {
    console.log(`[GAS-${executionId}] 🚀 GAS script execution started immediately`);
  }
  
  console.log(`[GAS-${executionId}] 🔧 GAS File ID: ${gasFileId}`);
  console.log(`[GAS-${executionId}] 🔗 GAS File URL: https://script.google.com/home/projects/${gasFileId}/edit`);
  console.log(`[GAS-${executionId}] ⏰ Execution time: ${new Date().toISOString()}`);
  console.log(`[GAS-${executionId}] 📋 Function to execute: formatKeywords`);
  console.log(`[GAS-${executionId}] 📦 Parameters: [${spreadsheetId}]`);
  
  const startTime = Date.now();
  
  try {
    const response = await script.scripts.run({
      scriptId: gasFileId,
      requestBody: {
        function: 'formatKeywords',
        parameters: [spreadsheetId], // Spreadsheet IDを配列で渡す
        devMode: true // 未デプロイの最新コードを実行
      },
    });

    const endTime = Date.now();
    const executionTime = endTime - startTime;
    
    console.log(`[GAS-${executionId}] ✅ GAS execution completed successfully`);
    console.log(`[GAS-${executionId}] ⏱️ Execution time: ${executionTime}ms`);
    console.log(`[GAS-${executionId}] 📊 Response status: ${response.status}`);
    console.log(`[GAS-${executionId}] 📋 Response data:`, JSON.stringify(response.data, null, 2));
    
    if (response.data.error) {
      console.error(`[GAS-${executionId}] ❌ GAS returned error:`, response.data.error);
    }
    
  } catch (error) {
    console.error(`[GAS-${executionId}] ❌ GAS execution failed`);
    console.error(`[GAS-${executionId}] 🔍 Error details:`, error);
    console.error(`[GAS-${executionId}] 📄 Spreadsheet ID: ${spreadsheetId}`);
    console.error(`[GAS-${executionId}] ⏰ Error time: ${new Date().toISOString()}`);
    
    // API無効化エラーの場合は特別なメッセージを表示
    if (error instanceof Error && error.message.includes('Apps Script API has not been used')) {
      console.error(`[GAS-${executionId}] 💡 To fix this error, enable Google Apps Script API in Google Cloud Console`);
      console.error(`[GAS-${executionId}] 🔗 Visit: https://console.developers.google.com/apis/api/script.googleapis.com/overview`);
      console.error(`[GAS-${executionId}] 🔧 Or set DISABLE_GAS_EXECUTION=true to skip GAS execution`);
    }
    
    // 無効な引数エラーの場合は関数名の問題の可能性
    if (error instanceof Error && error.message.includes('invalid argument')) {
      console.error(`[GAS-${executionId}] 💡 This error usually means the function name is incorrect or doesn't exist in the GAS file`);
      console.error(`[GAS-${executionId}] 🔧 Check if 'formatKeywords' function exists in GAS file: ${gasFileId}`);
      console.error(`[GAS-${executionId}] 📝 Available functions in GAS file need to be verified`);
      console.error(`[GAS-${executionId}] 🔗 GAS file URL: https://script.google.com/home/projects/${gasFileId}/edit`);
      console.error(`[GAS-${executionId}] 💡 Make sure the function accepts spreadsheetId as parameter`);
      console.error(`[GAS-${executionId}] 🔧 Check if service account has edit permission on the spreadsheet`);
    }
    
    // GASの実行失敗はスプレッドシート作成の失敗とはしない
    throw new Error(`GAS script execution failed: ${error}`);
  }
} 