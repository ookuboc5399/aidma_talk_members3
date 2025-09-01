import OpenAI from "openai";
import type { MembersMessage } from "@/lib/membersApi";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export interface CompanyInfo {
  businessContent: string;    // 事業内容 → C6
  representative: string;     // 代表者 → C2
  employeeCount: string;      // 従業員数 → C4
  headOfficeAddress: string;  // 本社住所 → F2
}

export async function generateCompanyInfo(companyName: string, companyUrl: string): Promise<CompanyInfo> {
  const prompt = `以下の企業について、利用可能な情報から企業情報を抽出してください。

企業名: ${companyName}
企業URL: ${companyUrl}

以下の項目について、取得できる情報のみを記載してください。不明な項目は「不明」と記載してください。

1. 事業内容: 主要な事業・サービス内容を簡潔に
2. 代表者: 代表取締役や社長の氏名
3. 従業員数: 正確な人数または概算
4. 本社住所: 本社所在地の住所

出力フォーマット:
事業内容: [内容]
代表者: [氏名]
従業員数: [人数]
本社住所: [住所]`;

  const callId = Date.now();
  console.log(`[COMPANY-INFO-${callId}] 📤 企業情報取得API呼び出し開始`);
  console.log(`[COMPANY-INFO-${callId}] 企業名: ${companyName}, URL: ${companyUrl}`);

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.1,
    });

    const content = response.choices[0]?.message?.content || "";
    console.log(`[COMPANY-INFO-${callId}] 📥 企業情報取得完了 (${content.length}文字)`);

    // レスポンスをパース
    const companyInfo = parseCompanyInfo(content);
    console.log(`[COMPANY-INFO-${callId}] パース結果:`, companyInfo);

    return companyInfo;
  } catch (error) {
    console.error(`[COMPANY-INFO-${callId}] ❌ エラー:`, error);
    return {
      businessContent: "取得できませんでした",
      representative: "不明",
      employeeCount: "不明", 
      headOfficeAddress: "不明"
    };
  }
}

function parseCompanyInfo(content: string): CompanyInfo {
  const lines = content.split('\n');
  
  let businessContent = "不明";
  let representative = "不明";
  let employeeCount = "不明";
  let headOfficeAddress = "不明";

  for (const line of lines) {
    const trimmedLine = line.trim();
    
    if (trimmedLine.startsWith('事業内容:')) {
      businessContent = trimmedLine.replace('事業内容:', '').trim();
    } else if (trimmedLine.startsWith('代表者:')) {
      representative = trimmedLine.replace('代表者:', '').trim();
    } else if (trimmedLine.startsWith('従業員数:')) {
      employeeCount = trimmedLine.replace('従業員数:', '').trim();
    } else if (trimmedLine.startsWith('本社住所:')) {
      headOfficeAddress = trimmedLine.replace('本社住所:', '').trim();
    }
  }

  return {
    businessContent,
    representative,
    employeeCount,
    headOfficeAddress
  };
}

export function extractCompanyBasicInfo(messages: MembersMessage[]): { companyName: string; companyUrl: string } {
  let companyName = "";
  let companyUrl = "";

  for (const message of messages) {
    const body = message.body || "";
    
    // ■基本情報から企業名を抽出
    const basicInfoMatch = body.match(/■基本情報\s*([^\n■]+)/);
    if (basicInfoMatch) {
      companyName = basicInfoMatch[1].trim();
    }

    // ■企業URLを抽出
    const urlMatch = body.match(/■企業URL\s*([^\n■]+)/);
    if (urlMatch) {
      companyUrl = urlMatch[1].trim();
    }
  }

  return { companyName, companyUrl };
}
