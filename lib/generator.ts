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
}

export interface GenerateResult {
  content: string;
  model: string;
  mode: "reasoning" | "chat";
  messages: MembersMessage[];
}

export async function generateSalesScriptFromContext(opts: GenerateOptions): Promise<GenerateResult> {
  const messages = await getRoomMessages(opts.roomId, { force: opts.force ?? 1 });
  const recent = messages.slice(-50).map((m) => `- ${m.account?.name ?? ""}: ${m.body.replace(/<[^>]+>/g, " ")}`).join("\n");

  const plotsPdf = await readPdfTextFromPublic(process.env.KNOWLEDGE_PLOTS_PDF);
  const qaPdf = await readPdfTextFromPublic(process.env.KNOWLEDGE_QA_PDF);
  const csvs = await readCsvTextsFromPublic(process.env.KNOWLEDGE_CSV_PATHS);

  const csvSection = csvs.length
    ? `\n【参考資料（CSV）】\n` + csvs.map((c) => `- ${c.filename}:\n${c.text}`).join("\n\n")
    : "";

  const instruction = `あなたは営業トーク台本作成の専門家です。以下のチャットと資料に基づき、表形式で「1) プロット①」「2) プロット②」「3) 想定Q&A」を日本語で出力してください。\n\n【チャット抜粋】\n${recent}\n\n【参考資料（PDF抽出）】\n- プロット:\n${plotsPdf}\n- Q&A:\n${qaPdf}${csvSection}`;

  const model = opts.modelOverride || (process.env.OPENAI_MODEL || (opts.useReasoning ? "o4-mini" : "gpt-4o-mini"));

  if (opts.useReasoning) {
    const resp = await openai.responses.create({
      model,
      reasoning: { effort: "medium" },
      instructions: "営業トーク台本の体裁を厳格に守ってください。",
      input: instruction,
    });
    return { content: resp.output_text || "", model, mode: "reasoning", messages };
  }

  const completion = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: "営業トーク台本の体裁を厳格に守ってください。" },
      { role: "user", content: instruction },
    ],
    temperature: 0.7,
  });
  const content = completion.choices?.[0]?.message?.content ?? "";
  return { content, model, mode: "chat", messages };
} 