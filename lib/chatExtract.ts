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
  const sections = {
    plot1: "",
    plot2: "",
    qa: "",
  };

  // Define regexes tailored to the actual document format
  // Start detection focuses on the key phrases (avoid generic "1)"/"2)" which collide with other headers)
  const plot1StartRegex = /プロット\s*①/;
  const plot2StartRegex = /プロット\s*②/;
  const qaStartRegex = /想定Q&A/;

  // Header removal regexes remove the whole header line such as "（プロット①／受付突破）" or "2) 想定Q&A（...）"
  const plot1HeaderRemoveRegex = /[（(]?\s*プロット\s*①[^\n]*[）)]?\s*/;
  const plot2HeaderRemoveRegex = /[（(]?\s*プロット\s*②[^\n]*[）)]?\s*/;
  const qaHeaderRemoveRegex = /(?:^|\n).*想定Q&A[^\n]*\n?/;

  // Find the start index of each section
  const findStartIndex = (regex: RegExp) => {
    const match = text.match(regex);
    return match && typeof match.index !== 'undefined' ? match.index : -1;
  };

  const plot1StartIndex = findStartIndex(plot1StartRegex);
  const plot2StartIndex = findStartIndex(plot2StartRegex);
  const qaStartIndex = findStartIndex(qaStartRegex);

  // Helper to extract text between two indices
  const getTextBetween = (start: number, end: number) => {
    if (start === -1) return "";
    const endPoint = end === -1 ? text.length : end;
    return text.substring(start, endPoint);
  };

  // Extract each section's full text (header + content)
  const plot1Full = getTextBetween(plot1StartIndex, plot2StartIndex);
  const plot2Full = getTextBetween(plot2StartIndex, qaStartIndex);
  const qaFull = getTextBetween(qaStartIndex, -1); // -1 means to the end of the string

  // Remove headers to get only the content
  if (plot1Full) sections.plot1 = plot1Full.replace(plot1HeaderRemoveRegex, "").trim();
  if (plot2Full) sections.plot2 = plot2Full.replace(plot2HeaderRemoveRegex, "").trim();
  if (qaFull) sections.qa = qaFull.replace(qaHeaderRemoveRegex, "").trim();

  return sections;
}

export function extractTitles(messages: MembersMessage[]): { basicInfoTitle: string; listInfoTitle: string } {
  const basicBody = extractSectionBody(messages, "■基本情報");
  const listBody = extractSectionBody(messages, "■リスト情報");
  const basicInfoTitle = basicBody.trim().split('\n')[0] || "無題";
  const listInfoTitle = listBody.trim().split('\n')[0] || "default";
  return { basicInfoTitle, listInfoTitle };
}
