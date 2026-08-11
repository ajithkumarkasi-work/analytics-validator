import type {
  DictPerEventMap,
  AttributeDescriptor,
  RawEvent,
  CoverageRow,
  GapAttribute,
  GapData,
  Platform,
} from "../shared/model/types";
import { parseCSV } from "./csv";

const normalizeKey = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "");

const toCamelCase = (value: string) => {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";

  if (/^[a-z][a-z0-9]*([A-Z][a-z0-9]*)*$/.test(trimmed)) {
    return trimmed;
  }

  const tokens = trimmed
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);

  if (!tokens.length) {
    return trimmed;
  }

  const [first, ...rest] = tokens;
  const lowerFirst = first.toLowerCase();

  const restCamel = rest.map((token) => {
    if (!token) return "";
    if (token.length <= 3 && token === token.toUpperCase()) {
      return token.toUpperCase();
    }
    return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
  });

  return [lowerFirst, ...restCamel].join("");
};

const groupEventsByName = (events: RawEvent[]) => {
  const map = new Map<string, RawEvent[]>();
  events.forEach((event) => {
    const name = event.eventName?.trim();
    if (!name) return;
    if (!map.has(name)) {
      map.set(name, []);
    }
    map.get(name)!.push(event);
  });
  return map;
};

const computeAttributePresence = (
  occurrences: RawEvent[] | undefined,
  attribute: string,
) => {
  const total = occurrences?.length ?? 0;
  if (!occurrences || occurrences.length === 0) {
    return { present: 0, total };
  }

  const normalizedAttribute = normalizeKey(attribute);
  let present = 0;

  occurrences.forEach((event) => {
    const hasAttribute = Object.keys(event).some((key) => {
      return (
        normalizeKey(key) === normalizedAttribute &&
        event[key] !== "" &&
        event[key] != null
      );
    });

    if (hasAttribute) {
      present += 1;
    }
  });

  return { present, total };
};

const deriveEventOrder = (events: RawEvent[]) => {
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const name = events[index]?.eventName?.trim();
    if (!name || name === "(empty)") continue;
    if (!seen.has(name)) {
      seen.add(name);
      ordered.push(name);
    }
  }

  return ordered;
};

const createEmptyMap = (eventNames: string[]): DictPerEventMap => {
  const map: DictPerEventMap = {};
  eventNames.forEach((event) => {
    map[event] = {};
  });
  return map;
};

const cleanAttributeName = (attribute: string, category: string) => {
  if (!attribute) return "";
  const trimmedAttr = attribute.trim();
  const trimmedCategory = category?.trim() ?? "";

  if (!trimmedCategory) return trimmedAttr;

  const patterns = [
    `${trimmedCategory} - `,
    `${trimmedCategory}-`,
    `${trimmedCategory}: `,
    `${trimmedCategory}:`,
    `${trimmedCategory} > `,
    `${trimmedCategory} >`,
    `${trimmedCategory}/`,
    `${trimmedCategory} `,
  ];

  for (const pattern of patterns) {
    if (trimmedAttr.toLowerCase().startsWith(pattern.toLowerCase())) {
      return trimmedAttr.slice(pattern.length).trim();
    }
  }

  return trimmedAttr;
};

const buildAttribute = (
  name: string,
  original: string,
  flag: string,
  category?: string,
): AttributeDescriptor => ({
  name,
  original,
  status: flag.includes("Y") ? "Y" : "O",
  category,
});

const findColumnIndex = (headers: string[], aliases: string[]): number => {
  const lowered = headers.map((header) => header?.toLowerCase() ?? "");
  return lowered.findIndex((header) =>
    aliases.some((alias) => header.includes(alias.toLowerCase())),
  );
};

export interface DictionaryMaps {
  all: DictPerEventMap;
  web: DictPerEventMap;
  mobile: DictPerEventMap;
  roku: DictPerEventMap;
}

export interface DictionaryParseResult extends DictionaryMaps {
  events: string[];
}

const CLONED_MAPS = ["all", "web", "mobile", "roku"] as const;

const buildGapForEvent = (
  eventName: string,
  dict: DictPerEventMap,
  occurrencesByEvent: Map<string, RawEvent[]>,
): {
  missing: GapAttribute[];
  partial: GapAttribute[];
  totalDict: number;
  totalRealTime: number;
} => {
  const definitions = dict[eventName];
  if (!definitions) {
    return { missing: [], partial: [], totalDict: 0, totalRealTime: 0 };
  }

  const descriptors = Object.values(definitions);
  const occurrences = occurrencesByEvent.get(eventName) ?? [];

  const missing: GapAttribute[] = [];
  const partial: GapAttribute[] = [];

  descriptors.forEach((descriptor) => {
    const { present, total } = computeAttributePresence(
      occurrences,
      descriptor.name,
    );
    const optional = descriptor.status === "O";

    if (present === 0) {
      if (!optional) {
        missing.push({
          name: descriptor.name,
          optional: false,
          present,
          total,
        });
      }
      return;
    }

    if (present < total) {
      partial.push({ name: descriptor.name, optional, present, total });
    }
  });

  return {
    missing,
    partial,
    totalDict: descriptors.length,
    totalRealTime: occurrences.length,
  };
};

const upsertAttribute = (
  maps: DictionaryMaps,
  eventName: string,
  attribute: AttributeDescriptor,
  include: { web: boolean; mobile: boolean; roku: boolean },
) => {
  maps.all[eventName] ??= {};
  maps.all[eventName][attribute.name] = attribute;

  if (include.web) {
    maps.web[eventName] ??= {};
    maps.web[eventName][attribute.name] = attribute;
  }

  if (include.mobile) {
    maps.mobile[eventName] ??= {};
    maps.mobile[eventName][attribute.name] = attribute;
  }

  if (include.roku) {
    maps.roku[eventName] ??= {};
    maps.roku[eventName][attribute.name] = attribute;
  }
};

const findHeaderRowIndex = (rows: string[][]): number =>
  rows.findIndex((row) => row.some((cell) => /APP_START/i.test(cell)));

const resolveEventStartIndex = (headerRow: string[]): number => {
  const sampleValuesIdx = headerRow.findIndex((cell) =>
    /sample values/i.test(cell),
  );
  if (sampleValuesIdx !== -1) {
    return sampleValuesIdx + 1;
  }

  const descriptionIdx = headerRow.findIndex((cell) =>
    /description/i.test(cell),
  );
  if (descriptionIdx !== -1) {
    return descriptionIdx + 1;
  }

  const appStartIdx = headerRow.findIndex((cell) => /APP_START/i.test(cell));
  if (appStartIdx === -1) {
    throw new Error(
      "Could not infer event columns (no Sample Values or Description or APP_START).",
    );
  }

  return appStartIdx;
};

const determinePlatformInclusion = (
  row: string[],
  indexes: { web: number; mobile: number; roku: number },
) => ({
  web:
    indexes.web > -1 &&
    Boolean(row[indexes.web] && !/^na$/i.test(row[indexes.web]?.trim() ?? "")),
  mobile:
    indexes.mobile > -1 &&
    Boolean(
      row[indexes.mobile] && !/^na$/i.test(row[indexes.mobile]?.trim() ?? ""),
    ),
  roku:
    indexes.roku > -1 &&
    Boolean(
      row[indexes.roku] && !/^na$/i.test(row[indexes.roku]?.trim() ?? ""),
    ),
});

const processDictionaryAttribute = ({
  row,
  columnIndex,
  eventStartIdx,
  events,
  attributeName,
  rawAttribute,
  include,
  maps,
  category,
}: {
  row: string[];
  columnIndex: number;
  eventStartIdx: number;
  events: string[];
  attributeName: string;
  rawAttribute: string;
  include: { web: boolean; mobile: boolean; roku: boolean };
  maps: DictionaryMaps;
  category?: string;
}) => {
  const flagRaw = row[columnIndex]?.trim();
  if (!flagRaw) return;

  const flagUpper = flagRaw.toUpperCase();
  if (!flagUpper.includes("Y") && flagUpper !== "O") return;

  const eventIdx = columnIndex - eventStartIdx;
  const eventName = events[eventIdx];
  if (!eventName) return;

  const attribute = buildAttribute(
    attributeName,
    rawAttribute,
    flagUpper,
    category,
  );
  upsertAttribute(maps, eventName, attribute, include);
};

const populateDictionaryMaps = (
  rows: string[][],
  headerRowIndex: number,
  eventStartIdx: number,
  events: string[],
  maps: DictionaryMaps,
  indexes: { web: number; mobile: number; roku: number },
) => {
  let currentCategory = "";

  for (
    let rowIndex = headerRowIndex + 1;
    rowIndex < rows.length;
    rowIndex += 1
  ) {
    const row = rows[rowIndex];
    if (!row || row.length <= eventStartIdx) continue;

    const categoryCell = row[1] ?? "";
    if (categoryCell.trim()) {
      currentCategory = categoryCell.trim();
    }

    const rawAttribute = row[2] ?? "";
    const attributeName = cleanAttributeName(rawAttribute, currentCategory);

    if (!attributeName || /^attribute$/i.test(attributeName)) continue;

    const include = determinePlatformInclusion(row, indexes);

    for (
      let columnIndex = eventStartIdx;
      columnIndex < row.length;
      columnIndex += 1
    ) {
      processDictionaryAttribute({
        row,
        columnIndex,
        eventStartIdx,
        events,
        attributeName,
        rawAttribute,
        include,
        maps,
        category: currentCategory,
      });
    }
  }
};

export const parseDictionary = (text: string): DictionaryParseResult => {
  const rows = parseCSV(text);
  if (!rows.length) {
    throw new Error("Dictionary CSV appears empty.");
  }

  const headerRowIndex = findHeaderRowIndex(rows);
  if (headerRowIndex === -1) {
    throw new Error("Could not locate events header (no APP_START column).");
  }

  const headerRow = rows[headerRowIndex];
  const eventStartIdx = resolveEventStartIndex(headerRow);
  const events = headerRow
    .slice(eventStartIdx)
    .filter((value) => value?.trim());
  if (!events.length) {
    throw new Error("No event names found in header row.");
  }

  const maps: DictionaryMaps = {
    all: createEmptyMap(events),
    web: createEmptyMap(events),
    mobile: createEmptyMap(events),
    roku: createEmptyMap(events),
  };

  const indexes = {
    web: findColumnIndex(headerRow, ["web platforms", "web"]),
    mobile: findColumnIndex(headerRow, [
      "mobile platforms",
      "mobile",
      "ios",
      "android",
    ]),
    roku: findColumnIndex(headerRow, ["roku"]),
  };

  populateDictionaryMaps(
    rows,
    headerRowIndex,
    eventStartIdx,
    events,
    maps,
    indexes,
  );

  return { ...maps, events };
};

export interface RealTimeParseResult {
  events: RawEvent[];
  playbackSessions: Set<string>;
  sessionIds: Set<string>;
  actionHeader: string;
}

const ACTION_CANDIDATES = [
  "Action Name",
  "actionName",
  "name",
  "event",
  "action",
];
const PLAYBACK_KEYS = [
  "playbackSessionId",
  "playback_session_id",
  "playbacksessionid",
];
const SESSION_KEYS = ["sessionId", "session_id", "sessionid"];

export const parseRealTimeData = (text: string): RealTimeParseResult => {
  const rows = parseCSV(text);
  if (!rows.length) {
    throw new Error("Real-time CSV appears empty.");
  }

  const headers = rows[0].map((header) => header?.trim() ?? "");
  let eventIndex = -1;

  for (const candidate of ACTION_CANDIDATES) {
    eventIndex = headers.findIndex(
      (header) => header.toLowerCase() === candidate.toLowerCase(),
    );
    if (eventIndex !== -1) break;
  }

  if (eventIndex === -1) {
    eventIndex = headers.findIndex((header) => /(action|event)/i.test(header));
  }

  if (eventIndex === -1) {
    throw new Error(
      "Real-time data must include an event/action column. Expected names include Action Name, actionName, eventName, name, event, or action.",
    );
  }

  const actionHeader = headers[eventIndex];
  const events: RawEvent[] = [];
  const playbackSessions = new Set<string>();
  const sessionIds = new Set<string>();

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row.length) continue;

    const eventName = row[eventIndex]?.trim() ?? "";
    const event: RawEvent = { eventName };

    headers.forEach((header, columnIndex) => {
      if (columnIndex === eventIndex) return;
      event[header] = row[columnIndex] ?? "";

      const normalizedHeader = normalizeKey(header);

      // Check if this header matches playbackSessionId (normalized)
      if (PLAYBACK_KEYS.some((key) => normalizeKey(key) === normalizedHeader)) {
        const value = row[columnIndex]?.trim();
        if (value) {
          playbackSessions.add(value);
        }
      }

      // Check if this header matches sessionId (normalized)
      if (SESSION_KEYS.some((key) => normalizeKey(key) === normalizedHeader)) {
        const value = row[columnIndex]?.trim();
        if (value) {
          sessionIds.add(value);
        }
      }
    });

    events.push(event);
  }

  return { events, playbackSessions, sessionIds, actionHeader };
};

export const calculateLetterStats = (
  events: RawEvent[],
  attribute: string,
): "Y" | "N" | "P" => {
  if (!events.length) return "N";
  const total = events.length;
  let presentCount = 0;
  const normalizedAttr = normalizeKey(attribute);

  events.forEach((event) => {
    // Check if this attribute exists in the event and has a non-empty value
    const hasAttribute = Object.keys(event).some((key) => {
      return (
        normalizeKey(key) === normalizedAttr &&
        event[key] !== "" &&
        event[key] != null
      );
    });
    if (hasAttribute) presentCount++;
  });

  if (presentCount === total) return "Y";
  if (presentCount > 0) return "P";
  return "N";
};

const ensureDictionaryEntry = (map: DictPerEventMap, eventName: string) => {
  if (!map[eventName]) {
    map[eventName] = {};
  }
};

const getEventPrefix = (eventName: string): string => {
  const regex = /^([A-Z_]+)_/;
  const match = regex.exec(eventName);
  return match ? match[1] : eventName;
};

const groupAndSortCoverageRows = (rows: CoverageRow[]): CoverageRow[] => {
  // Group events by prefix
  const grouped = new Map<string, CoverageRow[]>();

  rows.forEach((row) => {
    const prefix = getEventPrefix(row.eventName);
    if (!grouped.has(prefix)) {
      grouped.set(prefix, []);
    }
    grouped.get(prefix)!.push(row);
  });

  // Sort within each group by coverage, then by event name
  grouped.forEach((group) => {
    group.sort((a, b) => {
      if (b.coverage !== a.coverage) {
        return b.coverage - a.coverage;
      }
      return a.eventName.localeCompare(b.eventName);
    });
  });

  // Get all prefixes and sort them alphabetically
  const sortedPrefixes = Array.from(grouped.keys()).sort((a, b) =>
    a.localeCompare(b),
  );

  // Flatten the grouped events back into a single array
  const result: CoverageRow[] = [];
  sortedPrefixes.forEach((prefix) => {
    result.push(...grouped.get(prefix)!);
  });

  return result;
};

export const buildCoverageData = (
  dictionary: DictPerEventMap,
  events: RawEvent[],
  actionHeader: string,
): CoverageRow[] => {
  // Only include events that are present in the analytics data
  const eventNames = new Set<string>(events.map((event) => event.eventName));
  const occurrencesByEvent = groupEventsByName(events);
  const actionHeaderLower = actionHeader.toLowerCase();

  const coverageRows: CoverageRow[] = [];

  // Build global dictionary excluding the action header (event identifier column)
  const globalDictionaryNormalized = new Set<string>();
  Object.values(dictionary).forEach((attributes) => {
    Object.keys(attributes).forEach((attribute) => {
      // Skip the action header column name
      if (attribute.toLowerCase() === actionHeader.toLowerCase()) return;
      const normalized = normalizeKey(attribute);
      if (normalized) {
        globalDictionaryNormalized.add(normalized);
      }
    });
  });

  eventNames.forEach((eventName) => {
    ensureDictionaryEntry(dictionary, eventName);

    // Filter out the action header from dictionary attributes (e.g., "name", "eventName")
    // since it's the event identifier column, not an actual attribute
    const dictAttrs = Object.keys(dictionary[eventName]).filter(
      (attr) => attr.toLowerCase() !== actionHeader.toLowerCase(),
    );
    const realTimeEvents = occurrencesByEvent.get(eventName) ?? [];

    const missing: string[] = [];
    const partial: string[] = [];
    const onlyInRealTime: string[] = [];

    const presentCounts = new Map<string, number>();
    const realTimeAttributes = new Map<string, string>();

    realTimeEvents.forEach((event) => {
      Object.keys(event).forEach((key) => {
        if (!key) return;
        const trimmed = key.trim();
        if (!trimmed) return;
        if (trimmed.toLowerCase() === actionHeaderLower) return;
        if (trimmed === "eventName") return;

        const normalized = normalizeKey(trimmed);
        if (!normalized) return;

        if (!realTimeAttributes.has(normalized)) {
          realTimeAttributes.set(normalized, trimmed);
        }

        const value = event[key];
        if (value !== "" && value != null) {
          presentCounts.set(
            normalized,
            (presentCounts.get(normalized) ?? 0) + 1,
          );
        }
      });
    });

    const dictNormalized = new Map<string, string>();
    dictAttrs.forEach((attribute) => {
      const normalized = normalizeKey(attribute);
      if (!normalized) return;
      if (!dictNormalized.has(normalized)) {
        dictNormalized.set(normalized, attribute);
      }
    });

    const realTimeNormalized = new Map<string, string>();
    realTimeAttributes.forEach((attribute) => {
      const normalized = normalizeKey(attribute);
      if (!normalized) return;
      if (!realTimeNormalized.has(normalized)) {
        realTimeNormalized.set(normalized, attribute);
      }
    });

    dictAttrs.forEach((attribute) => {
      const normalized = normalizeKey(attribute);
      if (!normalized || !realTimeAttributes.has(normalized)) {
        missing.push(attribute);
        return;
      }

      const presentCount = presentCounts.get(normalized) ?? 0;
      if (presentCount < realTimeEvents.length) {
        partial.push(attribute);
      }
    });

    realTimeAttributes.forEach((attribute, normalized) => {
      if (!globalDictionaryNormalized.has(normalized)) {
        const displayLabel = toCamelCase(attribute);
        onlyInRealTime.push(displayLabel || attribute);
      }
    });

    const coverage =
      dictAttrs.length > 0
        ? Math.round(
            ((dictAttrs.length - missing.length - partial.length) /
              dictAttrs.length) *
              100,
          )
        : 0;

    coverageRows.push({
      eventName,
      totalAttributesInDict: dictAttrs.length,
      totalAttributesInRealTime: realTimeAttributes.size,
      coverage,
      missing,
      partial,
      onlyInRealTime,
    });
  });

  return groupAndSortCoverageRows(coverageRows);
};

export const buildGapData = (
  maps: Pick<DictionaryMaps, "web" | "mobile" | "roku">,
  events: RawEvent[],
): GapData[] => {
  const gapResults: GapData[] = [];
  const occurrencesByEvent = groupEventsByName(events);
  const orderedEvents = deriveEventOrder(events);

  const platforms: { name: Platform; map: DictPerEventMap }[] = [
    { name: "Web", map: maps.web },
    { name: "Mobile", map: maps.mobile },
    { name: "Roku", map: maps.roku },
  ];

  platforms.forEach(({ name, map }) => {
    orderedEvents.forEach((eventName) => {
      if (!map[eventName]) return;

      const { missing, partial, totalDict, totalRealTime } = buildGapForEvent(
        eventName,
        map,
        occurrencesByEvent,
      );

      if (missing.length > 0 || partial.length > 0) {
        gapResults.push({
          eventName,
          platform: name,
          missing,
          partial,
          totalDict,
          totalRealTime,
        });
      }
    });
  });

  return gapResults;
};
