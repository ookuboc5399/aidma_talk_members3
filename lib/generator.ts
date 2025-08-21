import OpenAI from "openai";
import { getRoomMessages, type MembersMessage } from "@/lib/membersApi";
import { extractListInfo } from "@/lib/chatExtract";
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

  // 指定されたMarkdownファイルを読み込む
  let talkScriptMd = await readTextFromPublic("tesc_talk_script.md");
  
  // チャットメッセージから呼び出し部署を抽出
  const listInfo = extractListInfo(messages);
  const callDepartment = listInfo.callDepartment;
  
  console.log(`[GENERATOR] 抽出されたリスト情報:`, {
    callDepartment: callDepartment,
    area: listInfo.area,
    extractionCondition: listInfo.extractionCondition
  });
  
  // 《△△》を呼び出し部署に置換（呼び出し部署が指定されている場合のみ）
  if (talkScriptMd && callDepartment) {
    talkScriptMd = talkScriptMd.replace(/《△△》/g, callDepartment);
    console.log(`[GENERATOR] 呼び出し部署「${callDepartment}」を《△△》に適用しました`);
  } else {
    console.log(`[GENERATOR] 呼び出し部署が見つからないため置換をスキップしました`);
  }
  
  const mdSection = talkScriptMd
    ? `\n【参考資料（営業トークスクリプトガイド）】\n${talkScriptMd}\n`
    : "";
  
  // 以前のCSV読み込み（コメントアウト）
  // const csvs = await readCsvTextsFromPublic("tesc_talk_script.csv");
  // const csvSection = csvs.length
  //   ? `\n【参考資料（CSV）】\n` + csvs.map((c) => `- ${c.filename}:\n${c.text}`).join("\n\n")
  //   : "";

  // prompt_for_chatgpt.txtの内容を読み込んでベースプロンプトとする
  const basePrompt = await readTextFromPublic("prompt_for_chatgpt.txt");

  // チャット履歴とMarkdownデータをプロンプトに含める
  const instruction = `${basePrompt}\n\n【チャット抜粋】\n${recent}${mdSection}`;

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