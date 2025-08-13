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
  // Reverse search to find the last message with the section header
  for (const m of messages.slice().reverse()) {
    const text = stripHtml(m.body);
    const index = text.indexOf(sectionHeader);
    if (index !== -1) {
      const fromHeader = text.substring(index + sectionHeader.length);
      const nextHeaderIndex = fromHeader.indexOf("■");
      const content = nextHeaderIndex === -1 ? fromHeader : fromHeader.substring(0, nextHeaderIndex);
      return content.trim();
    }
  }
  return "";
}

export function extractTitles(messages: MembersMessage[]): { basicInfoTitle: string; listInfoTitle: string } {
  const basicBody = extractSectionBody(messages, "■基本情報");
  const listBody = extractSectionBody(messages, "■リスト情報");
  const basicInfoTitle = basicBody.trim().split('\n')[0] || "無題";
  const listInfoTitle = listBody.trim().split('\n')[0] || "default";
  return { basicInfoTitle, listInfoTitle };
}
