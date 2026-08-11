export type Platform = "Web" | "Mobile" | "Roku";

export type ActiveTab = "dashboard" | "gaps" | "attributes";

export interface AttributeDescriptor {
  name: string;
  status: "Y" | "O";
  original: string;
  category?: string;
}

export interface DictPerEventMap {
  [eventName: string]: {
    [attribute: string]: AttributeDescriptor;
  };
}

export interface RawEvent {
  eventName: string;
  [key: string]: string;
}

export interface CoverageRow {
  eventName: string;
  totalAttributesInDict: number;
  totalAttributesInRealTime: number;
  coverage: number;
  missing: string[];
  partial: string[];
  onlyInRealTime: string[];
}

export interface GapAttribute {
  name: string;
  optional: boolean;
  present: number;
  total: number;
}

export interface GapData {
  eventName: string;
  platform: Platform;
  totalDict: number;
  totalRealTime: number;
  missing: GapAttribute[];
  partial: GapAttribute[];
}

export interface CoverageStats {
  totalRequired: number;
  totalRealTime: number;
  missingRequired: number;
  partialCount: number;
  extraPresent: number;
}
