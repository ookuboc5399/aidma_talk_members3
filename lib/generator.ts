import OpenAI from "openai";
import { getRoomMessages, type MembersMessage } from "@/lib/membersApi";
import fs from "node:fs/promises";
import path from "node:path";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function readPdfTextFromPublic(relativePath?: string): Promise<string> {
  if (!relativePath) return "";
  try {
    const p = path.join(process.cwd(), "public", relativePath.replace(/^\/+/, ""));
    await fs.access(p);
    const buf = await fs.readFile(p);
    const pdf = (await import("pdf-parse")).default as (b: Buffer | Uint8Array) => Promise<{ text: string }>;
    const out = await pdf(buf);
    return out.text || "";
  } catch {
    return "";
  }
}

async function readTextFromPublic(relativePath: string): Promise<string> {
  try {
    const p = path.join(process.cwd(), "public", relativePath.replace(/^\/+/, ""));
    await fs.access(p);
    const raw = await fs.readFile(p, "utf8");
    // Keep reasonable size to avoid context overflow
    return raw.length > 60000 ? raw.slice(0, 60000) + "\n...(truncated)" : raw;
  } catch {
    return "";
  }
}

async function readCsvTextsFromPublic(pathsCsv?: string): Promise<{ filename: string; text: string }[]> {
  if (!pathsCsv) return [];
  const items: { filename: string; text: string }[] = [];
  const parts = pathsCsv.split(",").map((s) => s.trim()).filter(Boolean);
  for (const rel of parts) {
    const text = await readTextFromPublic(rel);
    if (text) items.push({ filename: rel, text });
  }
  return items;
}

export interface GenerateOptions {
  roomId: number;
  force?: 0 | 1;
  useReasoning?: boolean;
  modelOverride?: string;
  targetMessageId?: number; // 特定のメッセージIDをターゲットにする場合
}

export interface GenerateResult {
  content: string;
  model: string;
  mode: "reasoning" | "chat";
  messages: MembersMessage[];
}

export async function generateSalesScriptFromContext(opts: GenerateOptions): Promise<GenerateResult> {
  const messages = await getRoomMessages(opts.roomId, { force: opts.force ?? 1 });
  
  // 特定のメッセージIDがターゲットの場合、そのメッセージのみを使用
  let targetMessages = messages;
  let contextInfo = "";
  
  if (opts.targetMessageId) {
    const targetMessage = messages.find(m => m.message_id === opts.targetMessageId);
    if (targetMessage) {
      // ターゲットメッセージのみを使用
      targetMessages = [targetMessage];
      contextInfo = `特定メッセージ(ID: ${opts.targetMessageId})`;
    } else {
      throw new Error(`Target message ID ${opts.targetMessageId} not found`);
    }
  } else {
    // 従来通り最新50件を使用
    targetMessages = messages.slice(-50);
    contextInfo = `最新${targetMessages.length}件のメッセージ`;
  }
  
  const recent = targetMessages.map((m) => `- ${m.account?.name ?? ""}: ${m.body.replace(/<[^>]+>/g, " ")}`).join("\n");
  
  // メッセージID情報を取得
  const messageIds = targetMessages.map(m => m.message_id);
  const latestMessageId = targetMessages.length > 0 ? targetMessages[targetMessages.length - 1].message_id : null;
  const messageCount = targetMessages.length;

  // PDFは使用しない
  const plotsPdf = "";
  const qaPdf = "";

  // 指定されたCSVファイルを読み込む
  const csvs = await readCsvTextsFromPublic("qa.csv,tesc_talk_script.csv");

  const csvSection = csvs.length
    ? `\n【参考資料（CSV）】\n` + csvs.map((c) => `- ${c.filename}:\n${c.text}`).join("\n\n")
    : "";

  // prompt_for_chatgpt.txtの内容をベースプロンプトとする
  const basePrompt = `あなたは、複数の業種に対応可能な汎用的な営業トークを作成のプロです\n\n✅ あなたが行うタスクは以下の2つです：\n※必ず 1）営業トークの作成 → 2）Q&Aの作成 の順番で実行してください。\n※営業トーク作成にあたっては、知識にアップロードされている「株式会社テスク御中_トークスクリプト【運用中】」のプロット①およびプロット②を参考にしてください。\n※読みやすさと視認性を重視し、句点（。）や読点（、）は自然な範囲で適切に使用してください。\n※会話調や親しみやすさは維持しつつも、文意が伝わりにくくならないよう、文を適切に区切る目的で句点は必ず使ってください。\n\n1)営業トークの作成\n対象企業の業種や強みを踏まえた営業トークを、以下の流れに沿って作成してください。\n\n フォーマットに関するルール：\n作成時は、アップロードされた **「プロット①」「プロット②」**をそれぞれ別々に参考にし、正しく反映してください。\nまた、知識にアップロードされた「株式会社テスク御中_トークスクリプト【運用中】」の内容も参考にしてください。\n\n「プロット①」「プロット②」いずれも、名乗りの部分では商材名やサービス名ではなく、**「ユーザー指定の企業名＋○○（担当者名）」**で名乗ってください。\n\n両プロットとも、複数業種に対応できる汎用的な内容にしてください。\n※○○業界など、特定業界に限定する言い回しは避け、幅広い業種に適用できるようにしてください。\n\n プロット①（受付突破）\n受付に対して、担当者へ繋いでもらうためのトークを作成してください。\n内容は、簡潔に営業感の薄い呼び出し方にしてください。\n\n作成時は、以下のフォーマットを厳守してください。\nこのフォーマットから逸脱した構成、順序の変更は行わないでください：\n\n【担当者呼出テンプレート】\nお世話になります。私、《企業名》の【○○】でございます。\n《○○》のご責任者様は\n「お見えでしょうか？（午前）」「お戻りでしょうか？（午後）」\n\n➡ いないと言われた場合は、以下の文言を使ってください：\n「それであれば、《○○についてわかる方》や、《○○を担当されている方》におつなぎいただけますでしょうか？」\n\n具体的にはと聞かれた場合、導入のメリットやベネフィットを端的に説明して、「お繋ぎいただけますでしょうか」と打診する文面にしてください。\n\n プロット②（営業対象者との通話）\n■出力構成（必須３ステップ）\n1. 私は何者で（約5秒）\n2. 何を目的に電話して（約5秒）\n3. 相手にとってのメリット（約10秒）\n\n■口語体トーン\n- 「です・ます調」ベースだが硬すぎない\n- 「○○なんです」「○○ですよ」「○○なんですけど」を多用\n- 「めちゃくちゃ」「ちゃんとした」など親しみやすい表現\n- 「おかげさまで」「実は」など自然な話し言葉\n- 関西弁は使わない\n\n■文体ルール\n- 句読点は極力使わない\n- 事例ベースで具体的数字を盛り込む\n- 相手の立場・課題を捉え、最後にクロージング\n\n――――――\n【ユーザーが入力した情報例】\n自社名／担当者名：○○株式会社の山田商材\n概要：永住権持ち外国人スタッフの派遣サービス\n強み・メリット：ビザ手続き不要／生活サポート込み\n具体事例：□□建設で工期短縮＋月販30％アップ\n\n――――――\n【期待する出力フォーマット】\n（コール直後）\nお忙しいところ恐縮です 実は○○株式会社の山田と申します」\n本日は□□業界の●●業務向けに即戦力となる人材派遣のご提案でお電話しまして」\n弊社は○○という強みがございまして～（メリット説明）～」\n\n――――――\n以上の仕様で、汎用的かつ自動的に台本を生成してください。\n\n✅ 切り返しに関する追加指示：\n切り返しの文末は、読点（、）で終わらせず、**「〜なので⇒クロージング」**のように、理由を伝えたあとに必ずクロージング文（行動を促す一文）を入れてください。\nクロージング文は、「一度お話だけでもできればと思いまして」「ぜひお力になれるかと存じます」など、自然に会話をつなげる形で完結してください。\n\nトーク作成時のルール：\n会話調の自然さを重視した文体としてください。\nクロージング（アポ取り）の文言は不要です。\n特定業界に限定しない汎用的な内容にしてください。\n\n2）想定Q&Aの作成\n対象企業に対して、営業シーンで想定ターゲットから受けそうな質問とその回答を複数パターン作成してください。\nこちらは、アップロードされた 「Q&A集参考資料」 を必ず参考にしてください。\n\n 前提として守るべきルール\n・ハルシネーション（事実に基づかない創作）は絶対にしないこと\n・アウトプットは、読み込んだ資料・知識のみを根拠にすること\n・資料に記載されていない情報は補完しないこと\n・「プロット①」「プロット②」 Q＆A集ともにExcelのような視認性の高い形で表示してください\n\nこの指示に厳密に従い、ユーザーの業種・企業情報に応じた自然で信頼感のある営業戦略・トーク・想定Q&Aを作成してください。`;

  // チャット履歴とCSVデータをプロンプトに含める
  const instruction = `${basePrompt}\n\n【チャット抜粋】\n${recent}${csvSection}`;

  const model = opts.modelOverride || (process.env.OPENAI_MODEL || (opts.useReasoning ? "o4-mini" : "gpt-4o-mini"));

  // API呼び出し回数をカウント（簡易的にタイムスタンプで識別）
  const callId = Date.now();
  console.log(`[OPENAI-${callId}] 📤 ChatGPT API 呼び出し開始`);
  console.log(`[OPENAI-${callId}] Room: ${opts.roomId}, Model: ${model}, Mode: ${opts.useReasoning ? "reasoning" : "chat"}`);
  console.log(`[OPENAI-${callId}] コンテキスト: ${contextInfo}`);
  console.log(`[OPENAI-${callId}] メッセージ数: ${messageCount}, 最新ID: ${latestMessageId}`);
  console.log(`[OPENAI-${callId}] 含まれるメッセージID: [${messageIds.join(', ')}]`);
  console.log(`[OPENAI-${callId}] プロンプト文字数: ${instruction.length}`);
  console.log(`[OPENAI-${callId}] プロンプト冒頭: ${instruction.substring(0, 200)}...`);

  if (opts.useReasoning) {
    console.log(`[OPENAI-${callId}] 送信中... (reasoning mode)`);
    const resp = await openai.responses.create({
      model,
      reasoning: { effort: "medium" },
      instructions: "営業トーク台本の体裁を厳格に守ってください。",
      input: instruction,
    });
    const content = resp.output_text || "";
    console.log(`[OPENAI-${callId}] 📥 レスポンス受信完了`);
    console.log(`[OPENAI-${callId}] 返却文字数: ${content.length}`);
    console.log(`[OPENAI-${callId}] 返却内容冒頭: ${content.substring(0, 300)}...`);
    return { content, model, mode: "reasoning", messages: targetMessages };
  }

  console.log(`[OPENAI-${callId}] 送信中... (chat mode)`);
  const completion = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: "営業トーク台本の体裁を厳格に守ってください。" },
      { role: "user", content: instruction },
    ],
    temperature: 0.7,
  });
  const content = completion.choices?.[0]?.message?.content ?? "";
  console.log(`[OPENAI-${callId}] 📥 レスポンス受信完了`);
  console.log(`[OPENAI-${callId}] 返却文字数: ${content.length}`);
  console.log(`[OPENAI-${callId}] 返却内容冒頭: ${content.substring(0, 300)}...`);
  console.log(`[OPENAI-${callId}] Usage: prompt_tokens=${completion.usage?.prompt_tokens}, completion_tokens=${completion.usage?.completion_tokens}`);
  return { content, model, mode: "chat", messages: targetMessages };
} 