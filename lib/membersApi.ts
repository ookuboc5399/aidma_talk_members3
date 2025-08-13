export const MEMBERS_BASE_URL = "https://api.mem-bers.jp/web-api";

export interface MembersAccount {
  account_id: number;
  name: string;
}

export interface MembersMessage {
  message_id: number;
  account: MembersAccount;
  type: number;
  body: string;
  send_time: number;
  update_time: number;
}

export type ForceOption = 0 | 1;

export interface GetRoomMessagesOptions {
  force?: ForceOption;
  token?: string;
}

export async function getRoomMessages(roomId: number | string, options: GetRoomMessagesOptions = {}): Promise<MembersMessage[]> {
  const force = options.force ?? 1;
  const token = options.token ?? process.env.MEMBERS_token ?? process.env.MEMBERS_TOKEN;
  if (!token) throw new Error("MEMBERSのAPIトークンが設定されていません（.env.local の MEMBERS_TOKEN を確認）");
  const url = `${MEMBERS_BASE_URL}/rooms/${roomId}/messages?force=${force}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MEMBERS APIエラー ${res.status}: ${text}`);
  }
  const json = (await res.json()) as MembersMessage[];
  return json ?? [];
} 