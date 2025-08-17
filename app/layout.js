export const metadata = { title: "Dashboard" };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily: "system-ui,-apple-system,Segoe UI,Roboto",
          background: "#eff4db",
          color: "#000"
        }}
      >
        {children}
      </body>
    </html>
  );
}
