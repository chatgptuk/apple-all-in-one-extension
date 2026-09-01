import React from 'react';

export type SymbolName =
  | 'settings'
  | 'plus'
  | 'aliases'
  | 'chevron-right'
  | 'search'
  | 'back'
  | 'copy'
  | 'check'
  | 'refresh'
  | 'autofill'
  | 'pause'
  | 'trash'
  | 'signout'
  | 'mail'
  | 'lock'
  | 'forward'
  | 'external'
  | 'cursor'
  | 'info'
  | 'clock'
  | 'globe'
  | 'key'
  | 'code';

type Props = {
  name: SymbolName;
  size?: number;
  className?: string;
  strokeWidth?: number;
};

const Symbol = ({ name, size = 18, className = '', strokeWidth = 1.8 }: Props) => {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  const glyph = (() => {
    switch (name) {
      case 'settings':
        return <><circle cx="12" cy="12" r="3.1" {...common}/><path d="M19.1 13.2v-2.4l-2-.6a7.5 7.5 0 0 0-.7-1.6l1-1.9-1.7-1.7-1.9 1a7.5 7.5 0 0 0-1.6-.7l-.6-2H9.2l-.6 2a7.5 7.5 0 0 0-1.6.7l-1.9-1-1.7 1.7 1 1.9a7.5 7.5 0 0 0-.7 1.6l-2 .6v2.4l2 .6c.2.6.4 1.1.7 1.6l-1 1.9 1.7 1.7 1.9-1c.5.3 1 .5 1.6.7l.6 2h2.4l.6-2c.6-.2 1.1-.4 1.6-.7l1.9 1 1.7-1.7-1-1.9c.3-.5.5-1 .7-1.6l2-.6Z" {...common}/></>;
      case 'plus':
        return <path d="M12 5v14M5 12h14" {...common}/>;
      case 'aliases':
        return <><path d="M8 7h11M8 12h11M8 17h11" {...common}/><circle cx="4.5" cy="7" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="17" r="1" fill="currentColor"/></>;
      case 'chevron-right':
        return <path d="m9 5 7 7-7 7" {...common}/>;
      case 'search':
        return <><circle cx="10.5" cy="10.5" r="6" {...common}/><path d="m15 15 4.5 4.5" {...common}/></>;
      case 'back':
        return <><path d="m10 5-7 7 7 7" {...common}/><path d="M4 12h16" {...common}/></>;
      case 'copy':
        return <><rect x="8" y="8" width="11" height="11" rx="2.5" {...common}/><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8" {...common}/></>;
      case 'check':
        return <path d="m5 12.5 4.2 4.2L19 7" {...common}/>;
      case 'refresh':
        return <><path d="M19 8a8 8 0 1 0 1 7" {...common}/><path d="M19 3v5h-5" {...common}/></>;
      case 'autofill':
        return <><path d="M4 18.5 14.8 7.7a2 2 0 0 1 2.8 0l.7.7a2 2 0 0 1 0 2.8L7.5 22H4v-3.5Z" {...common}/><path d="m13.5 9 3.5 3.5" {...common}/><path d="M5 4h6M8 1v6" {...common}/></>;
      case 'pause':
        return <><circle cx="12" cy="12" r="9" {...common}/><path d="M9.5 8.5v7M14.5 8.5v7" {...common}/></>;
      case 'trash':
        return <><path d="M4.5 7h15M9 4h6l1 3H8l1-3Z" {...common}/><path d="m7 7 .7 13h8.6L17 7M10 10v6M14 10v6" {...common}/></>;
      case 'signout':
        return <><path d="M10 4H6.5A2.5 2.5 0 0 0 4 6.5v11A2.5 2.5 0 0 0 6.5 20H10" {...common}/><path d="M14 8l4 4-4 4M9 12h9" {...common}/></>;
      case 'mail':
        return <><rect x="3" y="5.5" width="18" height="13" rx="3" {...common}/><path d="m4.5 7 6.2 5a2 2 0 0 0 2.6 0l6.2-5" {...common}/></>;
      case 'lock':
        return <><rect x="5" y="10" width="14" height="10" rx="3" {...common}/><path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10" {...common}/></>;
      case 'forward':
        return <><path d="M4 7h9M10 4l3 3-3 3" {...common}/><path d="M20 17h-9M14 14l-3 3 3 3" {...common}/></>;
      case 'external':
        return <><path d="M14 4h6v6M20 4l-9 9" {...common}/><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" {...common}/></>;
      case 'cursor':
        return <path d="m5 3 13 9-6 1.4L9.5 19 5 3Z" {...common}/>;
      case 'info':
        return <><circle cx="12" cy="12" r="9" {...common}/><path d="M12 10.5V17" {...common}/><circle cx="12" cy="7.3" r="1" fill="currentColor"/></>;
      case 'clock':
        return <><circle cx="12" cy="12" r="8.5" {...common}/><path d="M12 7.5V12l3.2 2" {...common}/></>;
      case 'globe':
        return <><circle cx="12" cy="12" r="9" {...common}/><path d="M3.5 12h17M12 3c2.4 2.5 3.6 5.5 3.6 9S14.4 18.5 12 21M12 3C9.6 5.5 8.4 8.5 8.4 12S9.6 18.5 12 21" {...common}/></>;
      case 'key':
        return <><circle cx="8.4" cy="9.2" r="4.2" {...common}/><path d="m11.5 12.3 8 8M15.2 16l2.6-2.6M17.4 18.2l2.3-2.3" {...common}/></>;
      case 'code':
        return <><path d="m8.2 7-4.5 5 4.5 5M15.8 7l4.5 5-4.5 5M13.6 4.5 10.4 19.5" {...common}/></>;
      default:
        return null;
    }
  })();

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {glyph}
    </svg>
  );
};

export default Symbol;
