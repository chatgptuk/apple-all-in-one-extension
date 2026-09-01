import React, { useId } from 'react';

type BrandIconProps = {
  size?: number;
  className?: string;
};

/**
 * Original code-drawn mark for Apple All-In-One.
 * The cloud represents Apple account/iCloud services; the keyhole represents
 * Passwords, passkeys and protected identity without copying an Apple app icon.
 */
const BrandIcon = ({ size = 36, className = '' }: BrandIconProps) => {
  const uid = useId().replace(/:/g, '');
  const bgId = `aaoBg${uid}`;
  const glassId = `aaoGlass${uid}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={bgId} x1="10" y1="6" x2="54" y2="59" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#69C0FF" />
          <stop offset="0.52" stopColor="#0A84FF" />
          <stop offset="1" stopColor="#0067D8" />
        </linearGradient>
        <linearGradient id={glassId} x1="20" y1="19" x2="45" y2="47" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFFFFF" stopOpacity=".98" />
          <stop offset="1" stopColor="#F5FAFF" stopOpacity=".90" />
        </linearGradient>
      </defs>

      <rect x="2" y="2" width="60" height="60" rx="15" fill={`url(#${bgId})`} />
      <path d="M8 15.8C17.5 8.1 32.5 5.7 49.5 9.8" fill="none" stroke="#FFFFFF" strokeOpacity=".30" strokeWidth="3.5" strokeLinecap="round" />
      <path d="M18.2 43.7h28.2c5 0 8.6-3.1 8.6-7.7 0-4.3-3.2-7.4-7.4-7.7C46.2 22 41 17.6 34.5 17.6c-5.2 0-9.8 2.9-12.1 7.3-5.7-.1-10.4 4.1-10.4 9.4 0 5.4 4.3 9.4 10.2 9.4Z" fill={`url(#${glassId})`} />
      <path d="M18.2 43.7h28.2c5 0 8.6-3.1 8.6-7.7 0-4.3-3.2-7.4-7.4-7.7C46.2 22 41 17.6 34.5 17.6c-5.2 0-9.8 2.9-12.1 7.3-5.7-.1-10.4 4.1-10.4 9.4 0 5.4 4.3 9.4 10.2 9.4Z" fill="none" stroke="#FFFFFF" strokeOpacity=".65" strokeWidth=".8" />
      <circle cx="33.5" cy="30.5" r="5.1" fill="#0A84FF" />
      <path d="M31.2 34.6h4.6l1.2 7.2c.15.9-.55 1.7-1.45 1.7h-4.1c-.9 0-1.6-.8-1.45-1.7l1.2-7.2Z" fill="#0A84FF" />
      <circle cx="33.5" cy="30.5" r="2.2" fill="#FFFFFF" fillOpacity=".96" />
      <path d="M8.5 52.5c12.8 4.6 30.7 3.7 46.7-7.1" fill="none" stroke="#0055B7" strokeOpacity=".16" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
};

export default BrandIcon;
