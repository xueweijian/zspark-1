import React from 'react'

// All icons stroke-based, 16x16, currentColor — Heroicons / Lucide style
const Wrap = (props: { children: React.ReactNode; size?: number }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={props.size ?? 16}
    height={props.size ?? 16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.7}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {props.children}
  </svg>
)

export const IconNewChat = () => (
  <Wrap>
    <path d="M12 5v14M5 12h14" />
  </Wrap>
)

export const IconSearch = () => (
  <Wrap>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Wrap>
)

export const IconSkills = () => (
  <Wrap>
    <path d="M12 2 4 6v6c0 5 3.5 8.5 8 10 4.5-1.5 8-5 8-10V6l-8-4z" />
    <path d="m9 12 2 2 4-4" />
  </Wrap>
)

export const IconPlugins = () => (
  <Wrap>
    <path d="M9 2v4M15 2v4M9 22v-4M15 22v-4" />
    <rect x="6" y="6" width="12" height="12" rx="3" />
  </Wrap>
)

export const IconAutomations = () => (
  <Wrap>
    <path d="M21 12a9 9 0 1 1-3.5-7.1" />
    <path d="M21 4v5h-5" />
  </Wrap>
)

export const IconProject = () => (
  <Wrap>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
  </Wrap>
)

export const IconSend = () => (
  <Wrap>
    <path d="m5 12 14-7-3 7 3 7-14-7z" />
  </Wrap>
)

export const IconClose = () => (
  <Wrap size={14}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Wrap>
)

export const IconSettings = () => (
  <Wrap>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </Wrap>
)

export const IconChevron = () => (
  <Wrap size={14}>
    <path d="m6 9 6 6 6-6" />
  </Wrap>
)

export const IconBrain = () => (
  <Wrap>
    <path d="M9.5 2A2.5 2.5 0 0 0 7 4.5v15A2.5 2.5 0 0 0 9.5 22h0a2.5 2.5 0 0 0 2.5-2.5V4.5A2.5 2.5 0 0 0 9.5 2z" />
    <path d="M14.5 2A2.5 2.5 0 0 1 17 4.5v15a2.5 2.5 0 0 1-2.5 2.5h0a2.5 2.5 0 0 1-2.5-2.5V4.5A2.5 2.5 0 0 1 14.5 2z" />
    <path d="M3 12h4M17 12h4" />
  </Wrap>
)

export const IconTerminal = () => (
  <Wrap>
    <path d="m4 8 4 4-4 4M11 16h7" />
    <rect x="2" y="4" width="20" height="16" rx="2" />
  </Wrap>
)

export const IconFile = () => (
  <Wrap>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6M9 13h6M9 17h4" />
  </Wrap>
)

export const IconImage = () => (
  <Wrap>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <circle cx="8.5" cy="10.5" r="1.5" />
    <path d="m21 15-4.5-4.5L7 20" />
  </Wrap>
)

export const IconTool = () => (
  <Wrap>
    <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4l-6 6a1 1 0 0 0 1.4 1.4l6-6a4 4 0 0 0 5.4-5.4l-2.7 2.7-2.1-2.1z" />
  </Wrap>
)

export const IconGlobe = () => (
  <Wrap>
    <circle cx="12" cy="12" r="10" />
    <path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" />
  </Wrap>
)
