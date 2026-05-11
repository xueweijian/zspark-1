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
