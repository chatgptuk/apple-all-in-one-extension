import React from 'react';
import symbols from '../icons/symbols.json';

// Original 24-point drawings, not redistributed SF Symbols assets. The same
// path catalog is packaged for the secure inline UI so glyphs cannot diverge.
export type SymbolName = keyof typeof symbols;

type Props = {
  name: SymbolName;
  size?: number;
  className?: string;
  strokeWidth?: number;
};

const Symbol = ({ name, size = 18, className = '', strokeWidth = 1.75 }: Props) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    className={`apple-symbol ${className}`}
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {symbols[name].map((d, index) => <path key={index} d={d} />)}
  </svg>
);

export default Symbol;
