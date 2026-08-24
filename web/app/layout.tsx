import type { Metadata } from 'next';
import '@fontsource/fraunces/400.css';
import '@fontsource/inter/400.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/noto-serif-tamil/400.css';
import './globals.css';
import './revision.css';

export const metadata: Metadata = {
  title: 'Kolam — structure in motion',
  description: 'A living interface for analysing and generating kolam structure.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
