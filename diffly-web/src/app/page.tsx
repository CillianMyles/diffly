import { DiffWorkbench } from "@/components/diff-workbench";

export default function Home() {
  return (
    <div>
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 10,
          backdropFilter: "blur(6px)",
          borderBottom: "1px solid var(--border)",
          background: "rgba(255,255,255,0.86)",
        }}
      >
        <div className="container" style={{ padding: "16px 0" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div
              style={{
                width: 14,
                height: 14,
                borderRadius: 999,
                background: "var(--brand)",
                boxShadow: "0 0 0 8px var(--brand-soft)",
              }}
            />
            <strong style={{ fontSize: 22, letterSpacing: -0.4 }}>diffly web</strong>
          </div>
        </div>
      </header>
      <main className="container" style={{ padding: "28px 0 56px" }}>
        <DiffWorkbench />
      </main>
    </div>
  );
}
