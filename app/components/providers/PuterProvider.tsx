'use client';

import Script from 'next/script';

export function PuterProvider({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Script src="https://js.puter.com/v2/" strategy="afterInteractive" />
      {children}
    </>
  );
}
