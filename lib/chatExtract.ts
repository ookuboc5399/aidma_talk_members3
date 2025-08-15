import type { MembersMessage } from "@/lib/membersApi";

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>(\r?\n)?/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export function extractSectionBody(messages: MembersMessage[], sectionHeader: string): string {
  // Search from the most recent message backward
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const rawBody = messages[i]?.body ?? "";
    const plain = stripHtml(rawBody);
    if (!plain.includes(sectionHeader)) continue;

    const lines = plain.split(/\r?\n/);
    const titleLineIndex = lines.findIndex((l) => l.includes(sectionHeader));
    if (titleLineIndex < 0) continue;

    const after = lines.slice(titleLineIndex + 1);
    // Cut off at the next section header starting with '■'
    const nextHeaderIndex = after.findIndex((l) => /^\s*■/.test(l));
    const bodyLines = nextHeaderIndex >= 0 ? after.slice(0, nextHeaderIndex) : after;
    const body = bodyLines.join("\n").trim();
    if (body) return body;
  }
  return "";
}

export function splitScriptBySections(text: string): { plot1: string; plot2: string; qa: string } {
  console.log("[SPLIT-DEBUG] Input text length:", text.length);
  console.log("[SPLIT-DEBUG] Input text preview:", text.substring(0, 500));
  
  const sections = {
    plot1: "",
    plot2: "",
    qa: "",
  };

  // Try multiple patterns for more flexible matching
  const plot1Patterns = [
    /プロット\s*①[（(][^）)]*[）)]/,
    /プロット\s*①/,
    /＜プロット①[^＞]*＞/
  ];
  
  const plot2Patterns = [
    /プロット\s*②[（(][^）)]*[）)]/,
    /プロット\s*②/,
    /＜プロット②[^＞]*＞/
  ];
  
  const qaPatterns = [
    /(?:2\s*\)\s*)?想定Q&A/,
    /想定質問/,
    /Q&A/
  ];

  // Find the best match for each section
  const findBestMatch = (patterns: RegExp[]) => {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && typeof match.index !== 'undefined') {
        return { index: match.index, pattern, match: match[0] };
      }
    }
    return { index: -1, pattern: null, match: "" };
  };

  const plot1Match = findBestMatch(plot1Patterns);
  const plot2Match = findBestMatch(plot2Patterns);
  const qaMatch = findBestMatch(qaPatterns);

  console.log("[SPLIT-DEBUG] Matches - Plot1:", plot1Match.index, plot1Match.match, "Plot2:", plot2Match.index, plot2Match.match, "QA:", qaMatch.index, qaMatch.match);

  // Helper to extract text between two indices
  const getTextBetween = (start: number, end: number) => {
    if (start === -1) return "";
    const endPoint = end === -1 ? text.length : end;
    return text.substring(start, endPoint);
  };

  // Extract each section's full text (header + content)
  const plot1Full = getTextBetween(plot1Match.index, plot2Match.index);
  const plot2Full = getTextBetween(plot2Match.index, qaMatch.index);
  const qaFull = getTextBetween(qaMatch.index, -1);

  console.log("[SPLIT-DEBUG] Raw sections - Plot1 length:", plot1Full.length, "Plot2 length:", plot2Full.length, "QA length:", qaFull.length);

  // Remove headers more carefully
  if (plot1Full && plot1Match.match) {
    sections.plot1 = plot1Full.replace(plot1Match.match, "").replace(/^\s*\n/, "").trim();
  }
  if (plot2Full && plot2Match.match) {
    sections.plot2 = plot2Full.replace(plot2Match.match, "").replace(/^\s*\n/, "").trim();
  }
  if (qaFull && qaMatch.match) {
    sections.qa = qaFull.replace(qaMatch.match, "").replace(/^\s*\n/, "").trim();
  }

  console.log("[SPLIT-DEBUG] Final sections - Plot1:", sections.plot1.length, "Plot2:", sections.plot2.length, "QA:", sections.qa.length);
  console.log("[SPLIT-DEBUG] Plot1 preview:", sections.plot1.substring(0, 200));
  console.log("[SPLIT-DEBUG] Plot2 preview:", sections.plot2.substring(0, 200));
  console.log("[SPLIT-DEBUG] QA preview:", sections.qa.substring(0, 200));

  return sections;
}

export function extractTitles(messages: MembersMessage[]): { basicInfoTitle: string; listInfoTitle: string } {
  const basicBody = extractSectionBody(messages, "■基本情報");
  const listBody = extractSectionBody(messages, "■リスト情報");
  const basicInfoTitle = basicBody.trim().split('\n')[0] || "無題";
  const listInfoTitle = listBody.trim().split('\n')[0] || "default";
  return { basicInfoTitle, listInfoTitle };
}
