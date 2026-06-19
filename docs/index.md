---
layout: home
hero:
  name: Madhusudan VA
  text: 100% pure Hinglish support
  tagline: Sealed with care. Delivered with love. Inbound voice agent for the Madhusudan dairy catalog — analytics, agent, telephony.
  actions:
    - theme: brand
      text: Architecture
      link: /architecture
    - theme: alt
      text: Calling Roadmap
      link: /calling-roadmap
features:
  - title: Analytics
    details: KPIs, time-band metrics, repeat-caller load, agent load, and daily trends from real call metadata.
    link: /call-metadata-analysis
  - title: Streaming voice agent
    details: Token-by-token Ollama streaming, tool registry, deterministic fallbacks, SSE endpoint.
    link: /agent-streaming
  - title: Telephony
    details: Exotel webhook + media-stream WebSocket, pluggable ASR/TTS, barge-in, warm transfer.
    link: /telephony
  - title: Roadmap
    details: Phased checklist from current skeleton to production calling at scale.
    link: /calling-roadmap
---

## What's in this site

Engineering reference for the Madhusudan inbound voice agent — analytics dashboard, streaming agent, telephony service, and the rollout plan to get from skeleton to live calling on a real Exotel DID.

| Doc | What it covers |
|---|---|
| [Project brief](/project-brief) | What we're building and why. |
| [Call metadata analysis](/call-metadata-analysis) | What the historical call data shows. |
| [Architecture](/architecture) | System layout, components, integration boundaries. |
| [Agent streaming](/agent-streaming) | `streamChat` contract, SSE, tool dispatch, how to add a tool. |
| [Telephony](/telephony) | Per-call pipeline, ASR/TTS adapters, barge-in, provider swaps. |
| [Calling roadmap](/calling-roadmap) | Master checklist from skeleton to production. |
| [Developer guide](/developer-guide) | Local setup, conventions, debugging. |
| [Platform guide](/platform-guide) | Capabilities and integration cards for non-engineers. |
| [Demo script](/demo-script) | How to walk a client through the demo. |
