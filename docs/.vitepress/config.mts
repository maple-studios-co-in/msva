import { defineConfig } from "vitepress";

// ---------------------------------------------------------------------------
// MSVA docs site (VitePress)
//
// Run with: pnpm --filter @msva/docs dev
// Build with: pnpm --filter @msva/docs build  → outputs to docs/.vitepress/dist
//
// The source is the existing docs/ folder. VitePress autoroutes each .md to
// /<filename> (e.g. docs/architecture.md → /architecture). Sidebar + nav are
// curated below so the order matches the README rather than alphabetical.
// ---------------------------------------------------------------------------

export default defineConfig({
  title: "Madhusudan VA",
  description: "Hinglish voice support for the Madhusudan dairy catalog — engineering reference",
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: true,

  head: [
    ["meta", { name: "theme-color", content: "#E63946" }],
    ["meta", { name: "og:title", content: "Madhusudan Voice Agent — Docs" }],
    ["meta", { name: "og:description", content: "Hinglish inbound voice support for the Madhusudan dairy catalog — engineering reference" }]
  ],

  themeConfig: {
    siteTitle: "MSVA Docs",

    nav: [
      { text: "Home", link: "/" },
      { text: "Architecture", link: "/architecture" },
      { text: "Roadmap", link: "/calling-roadmap" },
      {
        text: "Engineering",
        items: [
          { text: "Agent Streaming", link: "/agent-streaming" },
          { text: "Telephony", link: "/telephony" },
          { text: "Developer Guide", link: "/developer-guide" }
        ]
      },
      {
        text: "Product",
        items: [
          { text: "Project Brief", link: "/project-brief" },
          { text: "Platform Guide", link: "/platform-guide" },
          { text: "Demo Script", link: "/demo-script" },
          { text: "Call Metadata Analysis", link: "/call-metadata-analysis" }
        ]
      }
    ],

    sidebar: [
      {
        text: "Overview",
        items: [
          { text: "Introduction", link: "/" },
          { text: "Project Brief", link: "/project-brief" },
          { text: "Architecture", link: "/architecture" }
        ]
      },
      {
        text: "Engineering",
        collapsed: false,
        items: [
          { text: "Agent Streaming", link: "/agent-streaming" },
          { text: "Telephony", link: "/telephony" },
          { text: "Developer Guide", link: "/developer-guide" }
        ]
      },
      {
        text: "Rollout",
        collapsed: false,
        items: [
          { text: "Calling Roadmap", link: "/calling-roadmap" },
          { text: "Platform Features", link: "/platform-features" },
          { text: "Platform Guide", link: "/platform-guide" },
          { text: "Demo Script", link: "/demo-script" }
        ]
      },
      {
        text: "Data",
        collapsed: true,
        items: [{ text: "Call Metadata Analysis", link: "/call-metadata-analysis" }]
      }
    ],

    search: { provider: "local" },

    editLink: {
      pattern: "https://github.com/maple-studios/MSVA/edit/main/docs/:path",
      text: "Edit this page"
    },

    footer: {
      message: "Engineering reference for the Madhusudan inbound voice agent.",
      copyright: "© Madhusudan · Built by Maple Studios"
    }
  }
});
