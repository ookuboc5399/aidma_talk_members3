import "./globals.css";

export const metadata = {
  title: "MEMBERS Monitor",
  description: "Chat monitor and generator",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        {children}
      </body>
    </html>
  );
} 