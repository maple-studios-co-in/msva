// ../../docs/.vitepress/config.mts
import { defineConfig } from "file:///sessions/blissful-vigilant-feynman/mnt/MSVA/apps/docs/node_modules/vitepress/dist/node/index.js";
var config_default = defineConfig({
  title: "MSVA",
  description: "Madhu Sudhan Voice Agent \u2014 engineering reference",
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: true,
  head: [
    ["meta", { name: "theme-color", content: "#2a9d8f" }],
    ["meta", { name: "og:title", content: "MSVA Docs" }],
    ["meta", { name: "og:description", content: "Madhu Sudhan Voice Agent \u2014 engineering reference" }]
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
      message: "Engineering reference for the Madhu Sudhan Voice Agent.",
      copyright: "\xA9 Maple Studios"
    }
  }
});
export {
  config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vZG9jcy8udml0ZXByZXNzL2NvbmZpZy5tdHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvc2Vzc2lvbnMvYmxpc3NmdWwtdmlnaWxhbnQtZmV5bm1hbi9tbnQvTVNWQS9kb2NzLy52aXRlcHJlc3NcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9zZXNzaW9ucy9ibGlzc2Z1bC12aWdpbGFudC1mZXlubWFuL21udC9NU1ZBL2RvY3MvLnZpdGVwcmVzcy9jb25maWcubXRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9zZXNzaW9ucy9ibGlzc2Z1bC12aWdpbGFudC1mZXlubWFuL21udC9NU1ZBL2RvY3MvLnZpdGVwcmVzcy9jb25maWcubXRzXCI7aW1wb3J0IHsgZGVmaW5lQ29uZmlnIH0gZnJvbSBcInZpdGVwcmVzc1wiO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIE1TVkEgZG9jcyBzaXRlIChWaXRlUHJlc3MpXG4vL1xuLy8gUnVuIHdpdGg6IHBucG0gLS1maWx0ZXIgQG1zdmEvZG9jcyBkZXZcbi8vIEJ1aWxkIHdpdGg6IHBucG0gLS1maWx0ZXIgQG1zdmEvZG9jcyBidWlsZCAgXHUyMTkyIG91dHB1dHMgdG8gZG9jcy8udml0ZXByZXNzL2Rpc3Rcbi8vXG4vLyBUaGUgc291cmNlIGlzIHRoZSBleGlzdGluZyBkb2NzLyBmb2xkZXIuIFZpdGVQcmVzcyBhdXRvcm91dGVzIGVhY2ggLm1kIHRvXG4vLyAvPGZpbGVuYW1lPiAoZS5nLiBkb2NzL2FyY2hpdGVjdHVyZS5tZCBcdTIxOTIgL2FyY2hpdGVjdHVyZSkuIFNpZGViYXIgKyBuYXYgYXJlXG4vLyBjdXJhdGVkIGJlbG93IHNvIHRoZSBvcmRlciBtYXRjaGVzIHRoZSBSRUFETUUgcmF0aGVyIHRoYW4gYWxwaGFiZXRpY2FsLlxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmV4cG9ydCBkZWZhdWx0IGRlZmluZUNvbmZpZyh7XG4gIHRpdGxlOiBcIk1TVkFcIixcbiAgZGVzY3JpcHRpb246IFwiTWFkaHUgU3VkaGFuIFZvaWNlIEFnZW50IFx1MjAxNCBlbmdpbmVlcmluZyByZWZlcmVuY2VcIixcbiAgY2xlYW5VcmxzOiB0cnVlLFxuICBsYXN0VXBkYXRlZDogdHJ1ZSxcbiAgaWdub3JlRGVhZExpbmtzOiB0cnVlLFxuXG4gIGhlYWQ6IFtcbiAgICBbXCJtZXRhXCIsIHsgbmFtZTogXCJ0aGVtZS1jb2xvclwiLCBjb250ZW50OiBcIiMyYTlkOGZcIiB9XSxcbiAgICBbXCJtZXRhXCIsIHsgbmFtZTogXCJvZzp0aXRsZVwiLCBjb250ZW50OiBcIk1TVkEgRG9jc1wiIH1dLFxuICAgIFtcIm1ldGFcIiwgeyBuYW1lOiBcIm9nOmRlc2NyaXB0aW9uXCIsIGNvbnRlbnQ6IFwiTWFkaHUgU3VkaGFuIFZvaWNlIEFnZW50IFx1MjAxNCBlbmdpbmVlcmluZyByZWZlcmVuY2VcIiB9XVxuICBdLFxuXG4gIHRoZW1lQ29uZmlnOiB7XG4gICAgc2l0ZVRpdGxlOiBcIk1TVkEgRG9jc1wiLFxuXG4gICAgbmF2OiBbXG4gICAgICB7IHRleHQ6IFwiSG9tZVwiLCBsaW5rOiBcIi9cIiB9LFxuICAgICAgeyB0ZXh0OiBcIkFyY2hpdGVjdHVyZVwiLCBsaW5rOiBcIi9hcmNoaXRlY3R1cmVcIiB9LFxuICAgICAgeyB0ZXh0OiBcIlJvYWRtYXBcIiwgbGluazogXCIvY2FsbGluZy1yb2FkbWFwXCIgfSxcbiAgICAgIHtcbiAgICAgICAgdGV4dDogXCJFbmdpbmVlcmluZ1wiLFxuICAgICAgICBpdGVtczogW1xuICAgICAgICAgIHsgdGV4dDogXCJBZ2VudCBTdHJlYW1pbmdcIiwgbGluazogXCIvYWdlbnQtc3RyZWFtaW5nXCIgfSxcbiAgICAgICAgICB7IHRleHQ6IFwiVGVsZXBob255XCIsIGxpbms6IFwiL3RlbGVwaG9ueVwiIH0sXG4gICAgICAgICAgeyB0ZXh0OiBcIkRldmVsb3BlciBHdWlkZVwiLCBsaW5rOiBcIi9kZXZlbG9wZXItZ3VpZGVcIiB9XG4gICAgICAgIF1cbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIHRleHQ6IFwiUHJvZHVjdFwiLFxuICAgICAgICBpdGVtczogW1xuICAgICAgICAgIHsgdGV4dDogXCJQcm9qZWN0IEJyaWVmXCIsIGxpbms6IFwiL3Byb2plY3QtYnJpZWZcIiB9LFxuICAgICAgICAgIHsgdGV4dDogXCJQbGF0Zm9ybSBHdWlkZVwiLCBsaW5rOiBcIi9wbGF0Zm9ybS1ndWlkZVwiIH0sXG4gICAgICAgICAgeyB0ZXh0OiBcIkRlbW8gU2NyaXB0XCIsIGxpbms6IFwiL2RlbW8tc2NyaXB0XCIgfSxcbiAgICAgICAgICB7IHRleHQ6IFwiQ2FsbCBNZXRhZGF0YSBBbmFseXNpc1wiLCBsaW5rOiBcIi9jYWxsLW1ldGFkYXRhLWFuYWx5c2lzXCIgfVxuICAgICAgICBdXG4gICAgICB9XG4gICAgXSxcblxuICAgIHNpZGViYXI6IFtcbiAgICAgIHtcbiAgICAgICAgdGV4dDogXCJPdmVydmlld1wiLFxuICAgICAgICBpdGVtczogW1xuICAgICAgICAgIHsgdGV4dDogXCJJbnRyb2R1Y3Rpb25cIiwgbGluazogXCIvXCIgfSxcbiAgICAgICAgICB7IHRleHQ6IFwiUHJvamVjdCBCcmllZlwiLCBsaW5rOiBcIi9wcm9qZWN0LWJyaWVmXCIgfSxcbiAgICAgICAgICB7IHRleHQ6IFwiQXJjaGl0ZWN0dXJlXCIsIGxpbms6IFwiL2FyY2hpdGVjdHVyZVwiIH1cbiAgICAgICAgXVxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgdGV4dDogXCJFbmdpbmVlcmluZ1wiLFxuICAgICAgICBjb2xsYXBzZWQ6IGZhbHNlLFxuICAgICAgICBpdGVtczogW1xuICAgICAgICAgIHsgdGV4dDogXCJBZ2VudCBTdHJlYW1pbmdcIiwgbGluazogXCIvYWdlbnQtc3RyZWFtaW5nXCIgfSxcbiAgICAgICAgICB7IHRleHQ6IFwiVGVsZXBob255XCIsIGxpbms6IFwiL3RlbGVwaG9ueVwiIH0sXG4gICAgICAgICAgeyB0ZXh0OiBcIkRldmVsb3BlciBHdWlkZVwiLCBsaW5rOiBcIi9kZXZlbG9wZXItZ3VpZGVcIiB9XG4gICAgICAgIF1cbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIHRleHQ6IFwiUm9sbG91dFwiLFxuICAgICAgICBjb2xsYXBzZWQ6IGZhbHNlLFxuICAgICAgICBpdGVtczogW1xuICAgICAgICAgIHsgdGV4dDogXCJDYWxsaW5nIFJvYWRtYXBcIiwgbGluazogXCIvY2FsbGluZy1yb2FkbWFwXCIgfSxcbiAgICAgICAgICB7IHRleHQ6IFwiUGxhdGZvcm0gR3VpZGVcIiwgbGluazogXCIvcGxhdGZvcm0tZ3VpZGVcIiB9LFxuICAgICAgICAgIHsgdGV4dDogXCJEZW1vIFNjcmlwdFwiLCBsaW5rOiBcIi9kZW1vLXNjcmlwdFwiIH1cbiAgICAgICAgXVxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgdGV4dDogXCJEYXRhXCIsXG4gICAgICAgIGNvbGxhcHNlZDogdHJ1ZSxcbiAgICAgICAgaXRlbXM6IFt7IHRleHQ6IFwiQ2FsbCBNZXRhZGF0YSBBbmFseXNpc1wiLCBsaW5rOiBcIi9jYWxsLW1ldGFkYXRhLWFuYWx5c2lzXCIgfV1cbiAgICAgIH1cbiAgICBdLFxuXG4gICAgc2VhcmNoOiB7IHByb3ZpZGVyOiBcImxvY2FsXCIgfSxcblxuICAgIGVkaXRMaW5rOiB7XG4gICAgICBwYXR0ZXJuOiBcImh0dHBzOi8vZ2l0aHViLmNvbS9tYXBsZS1zdHVkaW9zL01TVkEvZWRpdC9tYWluL2RvY3MvOnBhdGhcIixcbiAgICAgIHRleHQ6IFwiRWRpdCB0aGlzIHBhZ2VcIlxuICAgIH0sXG5cbiAgICBmb290ZXI6IHtcbiAgICAgIG1lc3NhZ2U6IFwiRW5naW5lZXJpbmcgcmVmZXJlbmNlIGZvciB0aGUgTWFkaHUgU3VkaGFuIFZvaWNlIEFnZW50LlwiLFxuICAgICAgY29weXJpZ2h0OiBcIlx1MDBBOSBNYXBsZSBTdHVkaW9zXCJcbiAgICB9XG4gIH1cbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIjtBQUE4VixTQUFTLG9CQUFvQjtBQWEzWCxJQUFPLGlCQUFRLGFBQWE7QUFBQSxFQUMxQixPQUFPO0FBQUEsRUFDUCxhQUFhO0FBQUEsRUFDYixXQUFXO0FBQUEsRUFDWCxhQUFhO0FBQUEsRUFDYixpQkFBaUI7QUFBQSxFQUVqQixNQUFNO0FBQUEsSUFDSixDQUFDLFFBQVEsRUFBRSxNQUFNLGVBQWUsU0FBUyxVQUFVLENBQUM7QUFBQSxJQUNwRCxDQUFDLFFBQVEsRUFBRSxNQUFNLFlBQVksU0FBUyxZQUFZLENBQUM7QUFBQSxJQUNuRCxDQUFDLFFBQVEsRUFBRSxNQUFNLGtCQUFrQixTQUFTLHdEQUFtRCxDQUFDO0FBQUEsRUFDbEc7QUFBQSxFQUVBLGFBQWE7QUFBQSxJQUNYLFdBQVc7QUFBQSxJQUVYLEtBQUs7QUFBQSxNQUNILEVBQUUsTUFBTSxRQUFRLE1BQU0sSUFBSTtBQUFBLE1BQzFCLEVBQUUsTUFBTSxnQkFBZ0IsTUFBTSxnQkFBZ0I7QUFBQSxNQUM5QyxFQUFFLE1BQU0sV0FBVyxNQUFNLG1CQUFtQjtBQUFBLE1BQzVDO0FBQUEsUUFDRSxNQUFNO0FBQUEsUUFDTixPQUFPO0FBQUEsVUFDTCxFQUFFLE1BQU0sbUJBQW1CLE1BQU0sbUJBQW1CO0FBQUEsVUFDcEQsRUFBRSxNQUFNLGFBQWEsTUFBTSxhQUFhO0FBQUEsVUFDeEMsRUFBRSxNQUFNLG1CQUFtQixNQUFNLG1CQUFtQjtBQUFBLFFBQ3REO0FBQUEsTUFDRjtBQUFBLE1BQ0E7QUFBQSxRQUNFLE1BQU07QUFBQSxRQUNOLE9BQU87QUFBQSxVQUNMLEVBQUUsTUFBTSxpQkFBaUIsTUFBTSxpQkFBaUI7QUFBQSxVQUNoRCxFQUFFLE1BQU0sa0JBQWtCLE1BQU0sa0JBQWtCO0FBQUEsVUFDbEQsRUFBRSxNQUFNLGVBQWUsTUFBTSxlQUFlO0FBQUEsVUFDNUMsRUFBRSxNQUFNLDBCQUEwQixNQUFNLDBCQUEwQjtBQUFBLFFBQ3BFO0FBQUEsTUFDRjtBQUFBLElBQ0Y7QUFBQSxJQUVBLFNBQVM7QUFBQSxNQUNQO0FBQUEsUUFDRSxNQUFNO0FBQUEsUUFDTixPQUFPO0FBQUEsVUFDTCxFQUFFLE1BQU0sZ0JBQWdCLE1BQU0sSUFBSTtBQUFBLFVBQ2xDLEVBQUUsTUFBTSxpQkFBaUIsTUFBTSxpQkFBaUI7QUFBQSxVQUNoRCxFQUFFLE1BQU0sZ0JBQWdCLE1BQU0sZ0JBQWdCO0FBQUEsUUFDaEQ7QUFBQSxNQUNGO0FBQUEsTUFDQTtBQUFBLFFBQ0UsTUFBTTtBQUFBLFFBQ04sV0FBVztBQUFBLFFBQ1gsT0FBTztBQUFBLFVBQ0wsRUFBRSxNQUFNLG1CQUFtQixNQUFNLG1CQUFtQjtBQUFBLFVBQ3BELEVBQUUsTUFBTSxhQUFhLE1BQU0sYUFBYTtBQUFBLFVBQ3hDLEVBQUUsTUFBTSxtQkFBbUIsTUFBTSxtQkFBbUI7QUFBQSxRQUN0RDtBQUFBLE1BQ0Y7QUFBQSxNQUNBO0FBQUEsUUFDRSxNQUFNO0FBQUEsUUFDTixXQUFXO0FBQUEsUUFDWCxPQUFPO0FBQUEsVUFDTCxFQUFFLE1BQU0sbUJBQW1CLE1BQU0sbUJBQW1CO0FBQUEsVUFDcEQsRUFBRSxNQUFNLGtCQUFrQixNQUFNLGtCQUFrQjtBQUFBLFVBQ2xELEVBQUUsTUFBTSxlQUFlLE1BQU0sZUFBZTtBQUFBLFFBQzlDO0FBQUEsTUFDRjtBQUFBLE1BQ0E7QUFBQSxRQUNFLE1BQU07QUFBQSxRQUNOLFdBQVc7QUFBQSxRQUNYLE9BQU8sQ0FBQyxFQUFFLE1BQU0sMEJBQTBCLE1BQU0sMEJBQTBCLENBQUM7QUFBQSxNQUM3RTtBQUFBLElBQ0Y7QUFBQSxJQUVBLFFBQVEsRUFBRSxVQUFVLFFBQVE7QUFBQSxJQUU1QixVQUFVO0FBQUEsTUFDUixTQUFTO0FBQUEsTUFDVCxNQUFNO0FBQUEsSUFDUjtBQUFBLElBRUEsUUFBUTtBQUFBLE1BQ04sU0FBUztBQUFBLE1BQ1QsV0FBVztBQUFBLElBQ2I7QUFBQSxFQUNGO0FBQ0YsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
