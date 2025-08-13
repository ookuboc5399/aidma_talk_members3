declare module 'pdf-parse' {
  export interface PDFInfo {
    PDFFormatVersion?: string;
    IsAcroFormPresent?: boolean;
    IsXFAPresent?: boolean;
    // eslint-disable-next-line @typescript-eslint/ban-types
    metadata?: object | null;
  }
  export interface PDFParseResult {
    text: string;
    info?: PDFInfo;
    numpages?: number;
    numrender?: number;
    version?: string;
  }
  export default function pdf(dataBuffer: Buffer | Uint8Array): Promise<PDFParseResult>;
} 