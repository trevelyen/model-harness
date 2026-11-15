import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function make(path: React.ReactNode) {
  return function Icon({ size = 18, ...props }: IconProps) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        {path}
      </svg>
    );
  };
}

export const PlusIcon = make(<path d="M12 5v14M5 12h14" />);
export const ArrowUpIcon = make(<path d="M12 19V5M5 12l7-7 7 7" />);
export const StopIcon = make(<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />);
export const ChevronDownIcon = make(<path d="m6 9 6 6 6-6" />);
export const ChevronRightIcon = make(<path d="m9 6 6 6-6 6" />);
export const CopyIcon = make(<><rect x="9" y="9" width="11" height="11" rx="2.5" /><path d="M5 15V6a2 2 0 0 1 2-2h8" /></>);
export const CheckIcon = make(<path d="m5 12.5 4.5 4.5L19 7.5" />);
export const RefreshIcon = make(<><path d="M20 11a8 8 0 0 0-14.6-4.5L4 8" /><path d="M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14.6 4.5L20 16" /><path d="M20 20v-4h-4" /></>);
export const SettingsIcon = make(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></>);
export const SlidersIcon = make(<><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></>);
export const SidebarIcon = make(<><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" /></>);
export const TrashIcon = make(<><path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></>);
export const SaveIcon = make(<><path d="M5 4h11l3 3v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4Z" /><path d="M8 4v5h7V4M8 20v-6h8v6" /></>);
export const FolderIcon = make(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />);
export const FolderPlusIcon = make(<><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" /><path d="M12 10.5v5M9.5 13h5" /></>);
export const ArrowLeftIcon = make(<path d="M19 12H5M12 19l-7-7 7-7" />);
export const HomeIcon = make(<><path d="M4 11 12 4l8 7" /><path d="M6 10v9h12v-9" /></>);
export const XIcon = make(<path d="M6 6l12 12M18 6 6 18" />);
export const SearchIcon = make(<><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4-4" /></>);
export const SparkIcon = make(<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />);
export const BrainIcon = make(<><path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a2 2 0 0 0-3-1Z" /><path d="M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1" /></>);
export const InfoIcon = make(<><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5M12 7.5v.01" /></>);
export const AlertIcon = make(<><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.01" /></>);
export const ToolIcon = make(<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4Z" />);
export const LoopIcon = make(<><path d="M17 2l3 3-3 3" /><path d="M4 11V9a4 4 0 0 1 4-4h12" /><path d="M7 22l-3-3 3-3" /><path d="M20 13v2a4 4 0 0 1-4 4H4" /></>);
export const HookIcon = make(<><circle cx="12" cy="5" r="2" /><path d="M12 7v8a4 4 0 0 1-8 0v-1" /><path d="m2 16 2-2 2 2" /></>);
export const ServerIcon = make(<><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></>);
export const MicIcon = make(<><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>);
export const MicOffIcon = make(<><path d="M15 9.5V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.6 2.5" /><path d="M5 11a7 7 0 0 0 11.5 5.4M19 11a7 7 0 0 1-.6 2.8M12 18v3M4 4l16 16" /></>);
export const DiffIcon = make(<><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a1 1 0 0 0 1 1h5" /><path d="M9 10h6M12 7v6M9 17h6" /></>);
