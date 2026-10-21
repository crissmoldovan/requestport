import { type CSSProperties, createElement } from "react";

const bodyStyle: CSSProperties = {
  backgroundColor: "#f6f6f4",
  color: "#171717",
  fontFamily: "Arial, sans-serif",
  margin: 0,
  padding: "32px 16px",
};

const panelStyle: CSSProperties = {
  backgroundColor: "#ffffff",
  border: "1px solid #d8d8d4",
  margin: "0 auto",
  maxWidth: "480px",
  padding: "24px",
};

const linkStyle: CSSProperties = {
  backgroundColor: "#171717",
  color: "#ffffff",
  display: "inline-block",
  padding: "10px 14px",
  textDecoration: "none",
};

export function MagicLinkEmail({ url }: { url: string }) {
  return createElement(
    "html",
    { lang: "en" },
    createElement(
      "body",
      { style: bodyStyle },
      createElement(
        "div",
        { style: panelStyle },
        createElement(
          "h1",
          { style: { fontSize: "20px", margin: "0 0 12px" } },
          "Sign in to RequestPort",
        ),
        createElement(
          "p",
          { style: { lineHeight: 1.5 } },
          "Use this one-time link to continue. If you did not request it, you can ignore this email.",
        ),
        createElement(
          "a",
          { href: url, style: linkStyle },
          "Sign in to RequestPort",
        ),
      ),
    ),
  );
}
