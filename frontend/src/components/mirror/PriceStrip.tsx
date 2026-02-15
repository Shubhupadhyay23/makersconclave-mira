"use client";

export interface PriceStripItem {
  title: string;
  price?: string;
}

interface PriceStripProps {
  items: PriceStripItem[];
}

export default function PriceStrip({ items }: PriceStripProps) {
  if (items.length === 0) return null;

  return (
    <div
      style={{
        position: "absolute",
        bottom: 40,
        left: 0,
        right: 0,
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        gap: 12,
        padding: "10px 24px",
        background: "rgba(0, 0, 0, 0.5)",
        backdropFilter: "blur(6px)",
        color: "#fff",
        fontSize: "0.9rem",
        zIndex: 15,
      }}
    >
      {items.map((item, i) => (
        <span key={i}>
          {i > 0 && (
            <span style={{ opacity: 0.4, margin: "0 4px" }}>|</span>
          )}
          <span style={{ fontWeight: 500 }}>{item.title}</span>
          {item.price && (
            <span style={{ opacity: 0.7 }}> — {item.price}</span>
          )}
        </span>
      ))}
    </div>
  );
}
