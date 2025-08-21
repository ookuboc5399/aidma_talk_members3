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

export function splitScriptBySections(text: string): { plot1: string; plot2: string; plot3: string; plot4: string; plot5: string; qa: string } {
  console.log("[SPLIT-DEBUG] Input text length:", text.length);
  console.log("[SPLIT-DEBUG] Input text preview:", text.substring(0, 500));
  
  const sections = {
    plot1: "",
    plot2: "",
    plot3: "",
    plot4: "",
    plot5: "",
    qa: "",
  };

  // Try multiple patterns for more flexible matching
  const plot1Patterns = [
    /プロット\s*①[（(][^）)]*[）)]/,
    /プロット\s*①受付突破/,
    /プロット\s*①/,
    /＜プロット①[^＞]*＞/
  ];
  
  const plot2Patterns = [
    /プロット\s*②[（(][^）)]*[）)]/,
    /プロット\s*②/,
    /＜プロット②[^＞]*＞/
  ];
  
  const plot3Patterns = [
    /プロット\s*③[（(][^）)]*[）)]/,
    /プロット\s*③クロージング/,
    /プロット\s*③/,
    /＜プロット③[^＞]*＞/
  ];
  
  const plot4Patterns = [
    /プロット\s*④[（(][^）)]*[）)]/,
    /プロット\s*④情報確認/,
    /プロット\s*④/,
    /＜プロット④[^＞]*＞/
  ];
  
  const plot5Patterns = [
    /プロット\s*⑤[（(][^）)]*[）)]/,
    /プロット\s*⑤ヒアリング/,
    /プロット\s*⑤/,
    /＜プロット⑤[^＞]*＞/
  ];
  
  const qaPatterns = [
    /(?:6\s*\)\s*)?想定Q&A/,
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
  const plot3Match = findBestMatch(plot3Patterns);
  const plot4Match = findBestMatch(plot4Patterns);
  const plot5Match = findBestMatch(plot5Patterns);
  const qaMatch = findBestMatch(qaPatterns);

  console.log("[SPLIT-DEBUG] Matches - Plot1:", plot1Match.index, plot1Match.match, "Plot2:", plot2Match.index, plot2Match.match, "Plot3:", plot3Match.index, plot3Match.match, "Plot4:", plot4Match.index, plot4Match.match, "Plot5:", plot5Match.index, plot5Match.match, "QA:", qaMatch.index, qaMatch.match);

  // Helper to extract text between two indices
  const getTextBetween = (start: number, end: number) => {
    if (start === -1) return "";
    const endPoint = end === -1 ? text.length : end;
    return text.substring(start, endPoint);
  };

  // Sort matches by index to determine section boundaries
  const allMatches = [
    { name: "plot1", match: plot1Match },
    { name: "plot2", match: plot2Match },
    { name: "plot3", match: plot3Match },
    { name: "plot4", match: plot4Match },
    { name: "plot5", match: plot5Match },
    { name: "qa", match: qaMatch }
  ].filter(item => item.match.index !== -1).sort((a, b) => a.match.index - b.match.index);

  // Extract each section's full text (header + content)
  const plot1Full = getTextBetween(plot1Match.index, getNextSectionIndex(plot1Match.index, allMatches));
  const plot2Full = getTextBetween(plot2Match.index, getNextSectionIndex(plot2Match.index, allMatches));
  const plot3Full = getTextBetween(plot3Match.index, getNextSectionIndex(plot3Match.index, allMatches));
  const plot4Full = getTextBetween(plot4Match.index, getNextSectionIndex(plot4Match.index, allMatches));
  const plot5Full = getTextBetween(plot5Match.index, getNextSectionIndex(plot5Match.index, allMatches));
  const qaFull = getTextBetween(qaMatch.index, -1);

  // Helper function to get next section index
  function getNextSectionIndex(currentIndex: number, matches: typeof allMatches): number {
    const nextMatch = matches.find(m => m.match.index > currentIndex);
    return nextMatch ? nextMatch.match.index : -1;
  }

  console.log("[SPLIT-DEBUG] Raw sections - Plot1:", plot1Full.length, "Plot2:", plot2Full.length, "Plot3:", plot3Full.length, "Plot4:", plot4Full.length, "Plot5:", plot5Full.length, "QA:", qaFull.length);

 
  if (plot1Full && plot1Match.match) {
    sections.plot1 = plot1Full.replace(plot1Match.match, "").replace(/^\s*\n/, "").trim();
  }
  if (plot2Full && plot2Match.match) {
    sections.plot2 = plot2Full.replace(plot2Match.match, "").replace(/^\s*\n/, "").trim();
  }
  if (plot3Full && plot3Match.match) {
    sections.plot3 = plot3Full.replace(plot3Match.match, "").replace(/^\s*\n/, "").trim();
  }
  if (plot4Full && plot4Match.match) {
    sections.plot4 = plot4Full.replace(plot4Match.match, "").replace(/^\s*\n/, "").trim();
  }
  if (plot5Full && plot5Match.match) {
    sections.plot5 = plot5Full.replace(plot5Match.match, "").replace(/^\s*\n/, "").trim();
  }
  if (qaFull && qaMatch.match) {
    sections.qa = qaFull.replace(qaMatch.match, "").replace(/^\s*\n/, "").trim();
  }

  console.log("[SPLIT-DEBUG] Final sections - Plot1:", sections.plot1.length, "Plot2:", sections.plot2.length, "Plot3:", sections.plot3.length, "Plot4:", sections.plot4.length, "Plot5:", sections.plot5.length, "QA:", sections.qa.length);
  console.log("[SPLIT-DEBUG] Plot1 preview:", sections.plot1.substring(0, 200));
  console.log("[SPLIT-DEBUG] Plot2 preview:", sections.plot2.substring(0, 200));
  console.log("[SPLIT-DEBUG] Plot3 preview:", sections.plot3.substring(0, 200));
  console.log("[SPLIT-DEBUG] Plot4 preview:", sections.plot4.substring(0, 200));
  console.log("[SPLIT-DEBUG] Plot5 preview:", sections.plot5.substring(0, 200));
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
