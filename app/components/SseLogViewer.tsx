"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MembersMessage } from "@/lib/membersApi";

interface StatusEvent {
  type: "status" | "debug" | "error" | "hello" | "ping" | "messages";
  phase?: string;
  message?: string;
  model?: string;
  mode?: string;
  roomId?: number;
  intervalMs?: number;
  spreadsheetId?: string;
  title?: string;
  sheet?: string;
  messages?: MembersMessage[];
  content?: string;
}

export default function SseLogViewer({ defaultRoomId = 196320, defaultIntervalMs = 10000 }) {
  const [roomId, setRoomId] = useState<number>(defaultRoomId);
  const [intervalMs, setIntervalMs] = useState<number>(defaultIntervalMs);
  const [connected, setConnected] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [generateOnConnect, setGenerateOnConnect] = useState(false);
  const [debug, setDebug] = useState(false);
  const [exportOnGenerate, setExportOnGenerate] = useState(false);

  const [lastMessageId, setLastMessageId] = useState<number | null>(null);
  const [messages, setMessages] = useState<MembersMessage[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [scriptOutput, setScriptOutput] = useState<string>("");
  const [scriptMeta, setScriptMeta] = useState<{ model?: string; mode?: string }>({});
  const [manualExporting, setManualExporting] = useState(false);

  const esRef = useRef<EventSource | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const streamUrl = useMemo(() => {
    const params = new URLSearchParams({
      intervalMs: String(intervalMs),
      roomId: String(roomId),
      useReasoning: "1",
      generateOnConnect: generateOnConnect ? "1" : "0",
      exportOnGenerate: exportOnGenerate ? "1" : "0",
      debug: debug ? "1" : "0",
    });
    return `/api/members/messages/stream?${params.toString()}`;
  }, [intervalMs, roomId, generateOnConnect, exportOnGenerate, debug]);

  const appendLog = (line: string) => {
    setLogs((prev) => [...prev, `${new Date().toLocaleTimeString()}  ${line}`].slice(-500));
  };

  useEffect(() => {
    if (!connected) {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      return;
    }
    const es = new EventSource(streamUrl);
    esRef.current = es;

    es.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data) as StatusEvent;
        if (data.type === "hello") return;
        if (data.type === "ping") return;
        if (data.type === "debug") {
          // サーバ側で既に debug=1 の時のみ送られてくるが、念のためクライアントでも表示スイッチ
          if (debug) appendLog(`[DEBUG] ${data.message}`);
          return;
        }
        if (data.type === "error") {
          appendLog("エラーが発生しました。");
          alert(data.message || "エラー");
          return;
        }
        if (data.type === "status") {
          const phase = data.phase;
          if (phase === "poll_ok") appendLog("メッセージが取得できた。");
          if (phase === "generation_start") appendLog("chatgptにデータを送った。");
          if (phase === "generation_done") {
            appendLog("うまく生成された。");
            setScriptOutput(data.content || "");
            setScriptMeta({ model: data.model, mode: data.mode });
          }
          if (phase === "export_start") appendLog("スプレッドシートにデータを送った。");
          if (phase === "export_created" || phase === "export_done") appendLog("スプレッドシートが生成された。");
          return;
        }
        if (data.type === "messages") {
          const ms = data.messages as MembersMessage[];
          setMessages(ms);
          if (ms && ms.length > 0) setLastMessageId(ms[ms.length - 1].message_id);
          return;
        }
      } catch (e: unknown) {
        alert(e instanceof Error ? e.message : String(e));
      }
    };

    es.onerror = () => {
      appendLog("SSE接続でエラーが発生しました");
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [connected, streamUrl, debug]);

  useEffect(() => {
    if (!autoScroll) return;
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logs, autoScroll]);

  const handleConnect = () => setConnected(true);
  const handleDisconnect = () => setConnected(false);
  const handleClear = () => {
    setLogs([]);
    setMessages([]);
    setScriptOutput("");
    setScriptMeta({});
  };

  const handleManualExport = async () => {
    if (!connected) { // Connect状態をチェック
      alert("Connectしていません。");
      return;
    }
    if (!scriptOutput) { return alert("先にスクリプトを生成してください"); }
    setManualExporting(true);
    try {
      appendLog("スプレッドシートにデータを送った。");
      const res = await fetch("/api/sheets/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatMessages: messages, generatedScript: scriptOutput }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      appendLog("スプレッドシートが生成された。");
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setManualExporting(false);
    }
  };

  return (
    <div className="w-full max-w-5xl mx-auto space-y-4 flex flex-col h-full p-6 sm:p-10">
      <h1 className="text-2xl font-bold">MEMBERS チャット監視ログ</h1>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-sm text-gray-600">Room ID</label>
          <input className="border rounded px-3 py-1" type="number" value={roomId} onChange={(e) => setRoomId(Number(e.target.value))} />
        </div>
        <div>
          <label className="block text-sm text-gray-600">Interval(ms)</label>
          <input className="border rounded px-3 py-1" type="number" value={intervalMs} onChange={(e) => setIntervalMs(Number(e.target.value))} />
        </div>
        <label className="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} /> Auto scroll
        </label>
        <label className="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" checked={generateOnConnect} onChange={(e) => setGenerateOnConnect(e.target.checked)} /> Connect直後に生成
        </label>
        <label className="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" checked={exportOnGenerate} onChange={(e) => setExportOnGenerate(e.target.checked)} /> 生成後にシート作成
        </label>
        <label className="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" checked={debug} onChange={(e) => setDebug(e.target.checked)} /> Debug表示
        </label>
        <div className="ml-auto flex gap-2">
          {!connected ? (
            <button onClick={handleConnect} className="bg-blue-600 text-white px-3 py-1 rounded">Connect</button>
          ) : (
            <button onClick={handleDisconnect} className="bg-gray-600 text-white px-3 py-1 rounded">Disconnect</button>
          )}
          <button onClick={handleClear} className="border px-3 py-1 rounded">Clear</button>
          <button onClick={handleManualExport} className="border px-3 py-1 rounded disabled:opacity-50" disabled={manualExporting}>
            {manualExporting ? "作成中…" : "テスト作成"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <div className="text-sm font-semibold mb-1">Logs</div>
          <div ref={logRef} className="h-64 overflow-auto border rounded p-2 bg-white text-sm whitespace-pre-wrap">
            {logs.map((l, i) => (<div key={i}>{l}</div>))}
          </div>
        </div>
        <div>
          <div className="text-sm font-semibold mb-1">Messages ({messages.length}) lastId={lastMessageId ?? "-"}</div>
          <div className="h-64 overflow-auto border rounded p-2 bg-white text-sm space-y-2">
            {messages.map((m) => (
              <div key={m.message_id} className="border rounded p-2">
                <div className="text-xs text-gray-500">#{m.message_id} - {new Date(m.send_time * 1000).toLocaleString()}</div>
                <div className="font-semibold text-sm">{m.account?.name}</div>
                <div className="whitespace-pre-wrap" dangerouslySetInnerHTML={{ __html: m.body }} />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-2 flex-grow flex flex-col">
        <h2 className="font-semibold">Generated Script {scriptMeta.model ? `(${scriptMeta.model}/${scriptMeta.mode})` : ""}</h2>
        <div className="flex-grow overflow-auto border rounded p-2 bg-white text-sm whitespace-pre-wrap">
          {scriptOutput ? scriptOutput : <span className="text-gray-400">まだ生成結果はありません</span>}
        </div>
      </div>
    </div>
  );
} 