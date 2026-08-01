import {
  ChangeEvent,
  DragEvent,
  MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import "./style.css";
import type {
  ActiveTab,
  AttributeDescriptor,
  CoverageRow,
  DictPerEventMap,
  GapData,
  Platform,
  RawEvent,
} from "./types";
import {
  buildCoverageData,
  buildGapData,
  parseDictionary,
  parseRealTimeData,
  type DictionaryParseResult,
} from "./utils/analyticsLogic";
import { AttributeTooltip } from "./components/AttributeTooltip";

const DEFAULT_DICTIONARY_PATH = `${import.meta.env.BASE_URL}dd/`;

const readFileText = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => resolve((event.target?.result as string) ?? "");
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsText(file);
  });

const getDictionaryForPlatform = (
  dictionary: DictionaryParseResult | null,
  platform: "All" | Platform,
): DictPerEventMap => {
  if (!dictionary) return {};
  if (platform === "Web") return dictionary.web;
  if (platform === "Mobile") return dictionary.mobile;
  if (platform === "Roku") return dictionary.roku;
  return dictionary.all;
};

type GapSummary = {
  events: number;
  missing: number;
  partial: number;
};

const filterGapRows = (
  gaps: GapData[],
  platform: "All" | Platform,
  searchTerm: string,
) => {
  const lowered = searchTerm.trim().toLowerCase();
  return gaps.filter((gap) => {
    if (platform !== "All" && gap.platform !== platform) return false;
    if (!lowered) return true;

    const matchesEvent = gap.eventName.toLowerCase().includes(lowered);
    const matchesAttributes = [...gap.missing, ...gap.partial].some(
      (attribute) => attribute.name.toLowerCase().includes(lowered),
    );
    return matchesEvent || matchesAttributes;
  });
};

const summarizeGapData = (
  gaps: GapData[],
  platform: "All" | Platform,
): GapSummary => {
  const relevant =
    platform === "All" ? gaps : gaps.filter((gap) => gap.platform === platform);
  return {
    events: relevant.length,
    missing: relevant.reduce((total, gap) => total + gap.missing.length, 0),
    partial: relevant.reduce((total, gap) => total + gap.partial.length, 0),
  };
};

const sortAttributes = (attributes: AttributeDescriptor[]) =>
  [...attributes].sort((a, b) => a.name.localeCompare(b.name));

const platformLabel = (platform: "All" | Platform) =>
  platform === "All" ? "All" : platform;

type CoverageByPlatform = Record<"All" | Platform, CoverageRow[]>;

const resetCoverageState = (): CoverageByPlatform => ({
  All: [],
  Web: [],
  Mobile: [],
  Roku: [],
});

const fetchTextOrThrow = async (path: string, errorPrefix: string) => {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`${errorPrefix}: ${response.status}`);
  }
  return response.text();
};

const formatPlatformMeta = (
  dictionary: DictionaryParseResult | null,
  platform: "All" | Platform,
) => {
  if (!dictionary) return "";
  const mapped = getDictionaryForPlatform(dictionary, platform);
  const events = Object.keys(mapped).length;
  const attributes = Object.values(mapped).reduce(
    (total, attrs) => total + Object.keys(attrs).length,
    0,
  );
  return `${platformLabel(platform)}: ${events} events, ${attributes} attributes`;
};

const buildAttributeGroups = (
  dictionary: DictionaryParseResult,
  platform: "All" | Platform,
) => {
  const mapped = getDictionaryForPlatform(dictionary, platform);
  // List of common event identifier column names that should be excluded from attributes
  const eventColumnNames = ["name", "actionname", "action", "event"];

  return Object.entries(mapped).map(([eventName, attributes]) => {
    // Filter out event identifier columns from the attributes list
    const filteredAttributes = Object.values(attributes).filter((attr) => {
      const normalizedName = attr.name.toLowerCase().replace(/[^a-z0-9]/g, "");
      return !eventColumnNames.includes(normalizedName);
    });

    return {
      eventName,
      requiredCount: filteredAttributes.filter(
        (attribute) => attribute.status === "Y",
      ).length,
      optionalCount: filteredAttributes.filter(
        (attribute) => attribute.status === "O",
      ).length,
      attributes: sortAttributes(filteredAttributes),
    };
  });
};

const ensureAnalysisInputs = (
  dictionary: DictionaryParseResult | null,
  events: RawEvent[],
): dictionary is DictionaryParseResult => {
  if (!dictionary) {
    throw new Error("Please load the data dictionary first.");
  }
  if (events.length === 0) {
    throw new Error("Please load the real-time events CSV first.");
  }
  return true;
};

const fileFromDataTransfer = (dataTransfer: DataTransfer | null) =>
  dataTransfer?.files?.[0] ?? null;

const normalizeKeyValue = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "");

type CoveragePanelProps = {
  isVisible: boolean;
  analysisPerformed: boolean;
  coverageRows: CoverageRow[];
  selectedDictionaryMap: DictPerEventMap;
  attributeSearch: string;
  onAttributeSearchChange: (value: string) => void;
  eventSearch: string;
  onEventSearchChange: (value: string) => void;
  showPlaybackSessions: boolean;
  playbackSessions: string[];
  sessionIds: string[];
  selectedSessionId: string;
  onSessionIdChange: (value: string) => void;
  selectedPlaybackSessionId: string;
  onPlaybackSessionIdChange: (value: string) => void;
  copyPlaybackSessions: () => void;
  rawEvents: RawEvent[];
  canShowSessionInfo: boolean;
  onOpenSessionInfo: () => void;
};

type CellRender = {
  letter: string;
  style: CSSProperties;
  dataLetter?: string;
  dataStatus?: "Y" | "O";
  title: string;
};

type SessionInfoSection = {
  title: string;
  items: Array<{ label: string; value: string }>;
};

const CoveragePanel = ({
  isVisible,
  analysisPerformed,
  coverageRows,
  selectedDictionaryMap,
  attributeSearch,
  onAttributeSearchChange,
  eventSearch,
  onEventSearchChange,
  showPlaybackSessions,
  playbackSessions,
  sessionIds,
  selectedSessionId,
  onSessionIdChange,
  selectedPlaybackSessionId,
  onPlaybackSessionIdChange,
  copyPlaybackSessions,
  rawEvents,
  canShowSessionInfo,
  onOpenSessionInfo,
}: CoveragePanelProps) => {
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(),
  );

  const attributeQuery = attributeSearch.trim().toLowerCase();
  const eventQuery = eventSearch.trim().toLowerCase();

  // Filter raw events based on session selections
  const filteredRawEvents = useMemo(() => {
    const SESSION_KEYS = ["sessionId", "session_id", "sessionid"];
    const PLAYBACK_KEYS = [
      "playbackSessionId",
      "playback_session_id",
      "playbacksessionid",
    ];

    if (selectedSessionId === "All" && selectedPlaybackSessionId === "All") {
      return rawEvents;
    }

    if (rawEvents.length === 0) {
      return rawEvents;
    }

    const firstEvent = rawEvents[0];
    const eventKeys = Object.keys(firstEvent);

    let sessionKeyName: string | undefined;
    let playbackKeyName: string | undefined;

    if (selectedSessionId !== "All") {
      sessionKeyName = eventKeys.find((key) =>
        SESSION_KEYS.some(
          (sk) => normalizeKeyValue(sk) === normalizeKeyValue(key),
        ),
      );
    }

    if (selectedPlaybackSessionId !== "All") {
      playbackKeyName = eventKeys.find((key) =>
        PLAYBACK_KEYS.some(
          (pk) => normalizeKeyValue(pk) === normalizeKeyValue(key),
        ),
      );
    }

    return rawEvents.filter((event) => {
      if (sessionKeyName && event[sessionKeyName] !== selectedSessionId) {
        return false;
      }

      if (
        playbackKeyName &&
        event[playbackKeyName] !== selectedPlaybackSessionId
      ) {
        return false;
      }

      return true;
    });
  }, [rawEvents, selectedSessionId, selectedPlaybackSessionId]);

  const showSessionInfoButton =
    canShowSessionInfo && filteredRawEvents.length > 0;

  const eventOccurrencesMap = useMemo(() => {
    const occurrences: Record<string, RawEvent[]> = {};
    filteredRawEvents.forEach((event) => {
      if (!occurrences[event.eventName]) {
        occurrences[event.eventName] = [];
      }
      occurrences[event.eventName].push(event);
    });
    return occurrences;
  }, [filteredRawEvents]);

  const presenceStatsCache = useMemo(() => {
    const cache = new Map<
      string,
      { letter: "Y" | "P" | "N"; presentCount: number; total: number }
    >();

    Object.entries(eventOccurrencesMap).forEach(([eventName, occurrences]) => {
      if (occurrences.length === 0) {
        return;
      }

      const attributeKeys = new Set<string>();
      occurrences.forEach((event) => {
        Object.keys(event).forEach((key) => {
          attributeKeys.add(normalizeKeyValue(key));
        });
      });

      attributeKeys.forEach((normalizedAttribute) => {
        let presentCount = 0;
        occurrences.forEach((event) => {
          const hasAttribute = Object.keys(event).some((key) => {
            return (
              normalizeKeyValue(key) === normalizedAttribute &&
              event[key] !== "" &&
              event[key] != null
            );
          });
          if (hasAttribute) {
            presentCount += 1;
          }
        });

        const total = occurrences.length;
        let letter: "Y" | "P" | "N" = "N";
        if (presentCount === total && total > 0) {
          letter = "Y";
        } else if (presentCount > 0) {
          letter = "P";
        }

        cache.set(`${eventName}:${normalizedAttribute}`, {
          letter,
          presentCount,
          total,
        });
      });
    });

    return cache;
  }, [eventOccurrencesMap]);

  const sampleValuesCache = useMemo(() => {
    const cache = new Map<string, string[]>();
    const valueSets = new Map<string, Set<string>>();

    filteredRawEvents.forEach((event) => {
      Object.keys(event).forEach((key) => {
        const normalizedKey = normalizeKeyValue(key);
        if (!valueSets.has(normalizedKey)) {
          valueSets.set(normalizedKey, new Set<string>());
        }
        const rawValue = event[key];
        if (rawValue !== "" && rawValue != null) {
          const bucket = valueSets.get(normalizedKey)!;
          if (bucket.size < 5) {
            bucket.add(String(rawValue));
          }
        }
      });
    });

    valueSets.forEach((values, key) => {
      cache.set(key, Array.from(values));
    });

    return cache;
  }, [filteredRawEvents]);

  const dictionaryAttributes = useMemo(() => {
    const set = new Set<string>();
    const eventColumnNames = ["name", "actionname", "action", "event"];

    coverageRows.forEach((row) => {
      const dictionaryForEvent = selectedDictionaryMap[row.eventName] ?? {};
      Object.keys(dictionaryForEvent).forEach((attribute) => {
        // Filter out event identifier columns
        const normalizedName = attribute
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "");
        if (!eventColumnNames.includes(normalizedName)) {
          set.add(attribute);
        }
      });
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [coverageRows, selectedDictionaryMap]);

  // Group attributes by category
  const attributesByCategory = useMemo(() => {
    const categoryMap = new Map<string, AttributeDescriptor[]>();
    const uncategorized: AttributeDescriptor[] = [];

    dictionaryAttributes.forEach((attributeName) => {
      // Find the attribute descriptor with category info
      let descriptor: AttributeDescriptor | undefined;
      for (const row of coverageRows) {
        const dictionaryForEvent = selectedDictionaryMap[row.eventName];
        const attribute = dictionaryForEvent?.[attributeName];
        if (attribute) {
          descriptor = attribute;
          break;
        }
      }

      if (descriptor) {
        const category = descriptor.category || "Uncategorized";
        if (!categoryMap.has(category)) {
          categoryMap.set(category, []);
        }
        categoryMap.get(category)!.push(descriptor);
      }
    });

    // Sort categories alphabetically and sort attributes within each category
    const sorted = Array.from(categoryMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([category, attributes]) => {
        const sortedAttrs = [...attributes].sort((a, b) =>
          a.name.localeCompare(b.name),
        );
        return {
          category,
          attributes: sortedAttrs,
        };
      });

    return sorted;
  }, [dictionaryAttributes, coverageRows, selectedDictionaryMap]);

  const extraAttributes = useMemo(() => {
    const set = new Set<string>();
    coverageRows.forEach((row) => {
      row.onlyInRealTime.forEach((attribute) => set.add(attribute));
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [coverageRows]);

  const filteredDictionaryAttributes = useMemo(() => {
    if (!attributeQuery) return dictionaryAttributes;
    return dictionaryAttributes.filter((attribute) =>
      attribute.toLowerCase().includes(attributeQuery),
    );
  }, [attributeQuery, dictionaryAttributes]);

  // Filter categories based on search
  const filteredCategoriesBySearch = useMemo(() => {
    if (!attributeQuery) return attributesByCategory;

    return attributesByCategory
      .map(({ category, attributes }) => ({
        category,
        attributes: attributes.filter((attr) =>
          attr.name.toLowerCase().includes(attributeQuery),
        ),
      }))
      .filter(({ attributes }) => attributes.length > 0);
  }, [attributeQuery, attributesByCategory]);

  const toggleCategory = useCallback((category: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    const allCategories = attributesByCategory.map((g) => g.category);
    if (extraAttributes.length > 0) {
      allCategories.push("Extra Attributes");
    }
    setExpandedCategories(new Set(allCategories));
  }, [attributesByCategory, extraAttributes]);

  const collapseAll = useCallback(() => {
    setExpandedCategories(new Set());
  }, []);

  // Expand all categories by default when data loads
  useEffect(() => {
    const allCategories = attributesByCategory.map((g) => g.category);
    if (extraAttributes.length > 0) {
      allCategories.push("Extra Attributes");
    }
    setExpandedCategories(new Set(allCategories));
  }, [attributesByCategory, extraAttributes]);

  const filteredExtraAttributes = useMemo(() => {
    if (!attributeQuery) return extraAttributes;
    return extraAttributes.filter((attribute) =>
      attribute.toLowerCase().includes(attributeQuery),
    );
  }, [attributeQuery, extraAttributes]);

  const hasCoverage = analysisPerformed && coverageRows.length > 0;
  const hasExtraAttributes = filteredExtraAttributes.length > 0;
  const focusedAttribute = attributeQuery
    ? (filteredDictionaryAttributes[0] ?? filteredExtraAttributes[0] ?? null)
    : null;

  const eventMatches = useMemo(() => {
    if (!eventQuery) {
      return { hits: new Set<string>(), focus: null as string | null };
    }
    const matches: string[] = [];
    coverageRows.forEach((row) => {
      if (row.eventName.toLowerCase().includes(eventQuery)) {
        matches.push(row.eventName);
      }
    });
    return {
      hits: new Set(matches),
      focus: matches[0] ?? null,
    };
  }, [coverageRows, eventQuery]);

  const totalFilteredAttributes =
    filteredDictionaryAttributes.length + filteredExtraAttributes.length;
  const extraSummarySuffix = filteredExtraAttributes.length
    ? `, ${filteredExtraAttributes.length} extra`
    : "";
  const summaryText = attributeQuery
    ? `Showing ${totalFilteredAttributes} rows (${filteredDictionaryAttributes.length} dictionary${extraSummarySuffix})`
    : "";

  const describePresence = (value: "Y" | "P" | "N") => {
    if (value === "Y") return "All occurrences present";
    if (value === "P") return "Partial presence";
    return "None present";
  };

  const eventMatchCount = eventMatches.hits.size;
  const eventMatchSuffix = eventMatchCount === 1 ? "" : "es";
  const eventStatusText = eventQuery
    ? `${eventMatchCount} event match${eventMatchSuffix}`
    : "";

  const renderHighlightedLabel = (label: string) => {
    if (!attributeQuery) return label;
    const lower = label.toLowerCase();
    const index = lower.indexOf(attributeQuery);
    if (index === -1) return label;
    const before = label.slice(0, index);
    const match = label.slice(index, index + attributeQuery.length);
    const after = label.slice(index + attributeQuery.length);
    return (
      <>
        {before}
        <span className="attr-match">{match}</span>
        {after}
      </>
    );
  };

  const renderDictionaryCell = (
    eventName: string,
    attribute: string,
  ): CellRender => {
    const dictionaryForEvent = selectedDictionaryMap[eventName] ?? {};
    const dictionaryAttribute = dictionaryForEvent?.[attribute];
    const occurrences = eventOccurrencesMap[eventName] ?? [];
    const normalizedAttribute = normalizeKeyValue(attribute);
    const cachedStats = presenceStatsCache.get(
      `${eventName}:${normalizedAttribute}`,
    );
    const { letter, presentCount, total } = cachedStats ?? {
      letter: "N" as const,
      presentCount: 0,
      total: occurrences.length,
    };

    if (!dictionaryAttribute) {
      const emptyStyle: CSSProperties = {
        background: "#f9f9f9",
        color: "#666",
      };
      const title = total
        ? `Not in dictionary for this event (${presentCount}/${total})`
        : "Not in dictionary for this event";
      return {
        letter: "",
        style: emptyStyle,
        dataLetter: undefined,
        dataStatus: undefined,
        title,
      };
    }

    const countText = `(${presentCount}/${total})`;
    const presenceText = describePresence(letter);

    if (dictionaryAttribute.status === "O") {
      const optionalStyle: CSSProperties = {
        background: "#374151",
        color: "#fff",
        fontWeight: 600,
      };
      return {
        letter,
        style: optionalStyle,
        dataLetter: letter,
        dataStatus: "O",
        title: `${presenceText} (optional) ${countText}`,
      };
    }

    let background: string;
    if (letter === "Y") {
      background = "#def5d8";
    } else if (letter === "P") {
      background = "#fff4c2";
    } else {
      background = "#f8d7da";
    }

    const requiredStyle: CSSProperties = {
      background,
      color: "#0f172a",
      fontWeight: 600,
    };

    return {
      letter,
      style: requiredStyle,
      dataLetter: letter,
      dataStatus: "Y",
      title: `${presenceText} (required) ${countText}`,
    };
  };

  const renderExtraCell = (
    eventName: string,
    attribute: string,
  ): CellRender => {
    const occurrences = eventOccurrencesMap[eventName] ?? [];
    const normalizedAttribute = normalizeKeyValue(attribute);
    const cachedStats = presenceStatsCache.get(
      `${eventName}:${normalizedAttribute}`,
    );
    const presentCount = cachedStats?.presentCount ?? 0;
    const total = cachedStats?.total ?? occurrences.length;
    const hasValue = presentCount > 0;
    const letter = hasValue ? "A" : "";
    const title = hasValue
      ? `Extra present (${presentCount}/${total})`
      : `Extra absent (0/${total})`;
    const style: CSSProperties = hasValue
      ? {
          background: "#d6ecff",
          color: "#1e40af",
          fontWeight: 600,
        }
      : {
          background: "#f0f8ff",
          color: "#475569",
          fontWeight: 400,
        };

    return {
      letter,
      style,
      dataLetter: hasValue ? "A" : undefined,
      dataStatus: undefined,
      title,
    };
  };

  const hasLegendLetter = useMemo(() => {
    if (!hasCoverage) return false;
    for (const attribute of filteredDictionaryAttributes) {
      for (const row of coverageRows) {
        const cell = renderDictionaryCell(row.eventName, attribute);
        if (
          cell.dataLetter === "Y" ||
          cell.dataLetter === "N" ||
          cell.dataLetter === "P"
        ) {
          return true;
        }
      }
    }
    return false;
  }, [
    coverageRows,
    filteredDictionaryAttributes,
    hasCoverage,
    selectedDictionaryMap,
    eventOccurrencesMap,
  ]);

  return (
    <div
      id="dashboard-panel"
      className={`tab-panel ${isVisible ? "active" : ""}`}
      role="tabpanel"
      aria-labelledby="dashboard-tab"
    >
      {analysisPerformed && coverageRows.length > 0 ? (
        <section className="card fade-in sticky-coverage" id="coverage-section">
          <div className="coverage-header-bar">
            <h2>Data Dictionary Coverage</h2>
            <div
              className="coverage-search-group"
              aria-label="Coverage filters"
            >
              <div style={{ display: "flex", gap: "6px", marginRight: "8px" }}>
                <button
                  type="button"
                  onClick={expandAll}
                  className="btn-secondary tiny"
                  style={{ fontSize: "11px", padding: "4px 8px" }}
                  title="Expand all categories"
                >
                  Expand All
                </button>
                <button
                  type="button"
                  onClick={collapseAll}
                  className="btn-secondary tiny"
                  style={{ fontSize: "11px", padding: "4px 8px" }}
                  title="Collapse all categories"
                >
                  Collapse All
                </button>
              </div>
              <input
                type="text"
                id="attr-search"
                placeholder="Search attribute..."
                value={attributeSearch}
                onChange={(event) =>
                  onAttributeSearchChange(event.target.value)
                }
              />
              <div className="event-search-cluster">
                <input
                  type="text"
                  id="event-search"
                  placeholder="Find event..."
                  value={eventSearch}
                  onChange={(event) => onEventSearchChange(event.target.value)}
                />
                <span
                  id="event-search-status"
                  className="faded"
                  style={{ fontSize: "11px" }}
                >
                  {eventStatusText}
                </span>
              </div>
            </div>
          </div>
          <div className="card-header-line"></div>

          {/* Session Filters - Always show for testing */}
          <div
            className="session-filters"
            style={{
              padding: "12px 0",
              display: "flex",
              gap: "16px",
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <label
                htmlFor="session-filter"
                style={{ fontSize: "12px", fontWeight: 500, color: "#64748b" }}
              >
                Session ID:
              </label>
              <select
                id="session-filter"
                value={selectedSessionId}
                onChange={(e) => onSessionIdChange(e.target.value)}
                className="filter-select"
                style={{
                  padding: "4px 24px 4px 8px",
                  fontSize: "12px",
                  border: "1px solid #d1d5db",
                  borderRadius: "6px",
                  background: "white",
                  cursor: "pointer",
                }}
              >
                <option value="All">All ({sessionIds.length})</option>
                {sessionIds.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <label
                htmlFor="playback-filter"
                style={{ fontSize: "12px", fontWeight: 500, color: "#64748b" }}
              >
                Playback Session ID:
              </label>
              <select
                id="playback-filter"
                value={selectedPlaybackSessionId}
                onChange={(e) => onPlaybackSessionIdChange(e.target.value)}
                className="filter-select"
                style={{
                  padding: "4px 24px 4px 8px",
                  fontSize: "12px",
                  border: "1px solid #d1d5db",
                  borderRadius: "6px",
                  background: "white",
                  cursor: "pointer",
                }}
              >
                <option value="All">All ({playbackSessions.length})</option>
                {playbackSessions.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </div>

            <div
              style={{
                marginLeft: "auto",
                display: "flex",
                alignItems: "center",
                gap: "10px",
              }}
            >
              <div style={{ fontSize: "11px", color: "#64748b" }}>
                Showing {filteredRawEvents.length} of {rawEvents.length} events
              </div>
              {showSessionInfoButton && (
                <button
                  type="button"
                  onClick={onOpenSessionInfo}
                  className="session-info-button"
                  title="Show session details"
                >
                  <span className="session-info-icon" aria-hidden="true">
                    <svg viewBox="0 0 20 20" focusable="false">
                      <circle
                        cx="10"
                        cy="10"
                        r="9"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        fill="none"
                      />
                      <circle cx="10" cy="6" r="1.2" fill="currentColor" />
                      <rect
                        x="9.25"
                        y="8.5"
                        width="1.5"
                        height="7"
                        rx="0.75"
                        fill="currentColor"
                      />
                    </svg>
                  </span>
                  <span className="session-info-label">Show Info</span>
                </button>
              )}
            </div>
          </div>
          <div
            id="coverage-filter-summary"
            className="faded"
            style={{ margin: "2px 0 6px 2px", fontSize: "11px" }}
          >
            {summaryText}
          </div>
          {hasLegendLetter && (
            <div id="coverage-legend" className="coverage-legend">
              <div
                className="coverage-legend-flex"
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "14px",
                  alignItems: "center",
                  fontSize: "11.5px",
                  lineHeight: 1.2,
                }}
              >
                <span
                  className="legend-item legend-Y"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                  }}
                >
                  <span
                    style={{
                      width: "16px",
                      height: "16px",
                      display: "inline-block",
                      background: "#def5d8",
                      border: "1px solid #b7e7af",
                      borderLeft: "4px solid #16a34a",
                    }}
                  ></span>
                  <strong>Y</strong> all present
                </span>
                <span
                  className="legend-item legend-N"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                  }}
                >
                  <span
                    style={{
                      width: "16px",
                      height: "16px",
                      display: "inline-block",
                      background: "#f8d7da",
                      border: "1px solid #efb7bf",
                      borderLeft: "4px solid #e11d48",
                    }}
                  ></span>
                  <strong>N</strong> none
                </span>
                <span
                  className="legend-item legend-P"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                  }}
                >
                  <span
                    style={{
                      width: "16px",
                      height: "16px",
                      display: "inline-block",
                      background: "#fff4c2",
                      border: "1px solid #f3e09a",
                      borderLeft: "4px solid #d97706",
                    }}
                  ></span>
                  <strong>P</strong> partial
                </span>
                <span
                  className="legend-item legend-A"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                  }}
                >
                  <span
                    style={{
                      width: "16px",
                      height: "16px",
                      display: "inline-block",
                      background: "#d6ecff",
                      border: "1px solid #b6daf5",
                      borderLeft: "4px solid #0369a1",
                    }}
                  ></span>
                  <strong>A</strong> extra attr
                </span>
                <span
                  className="legend-item legend-O"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    flexWrap: "wrap",
                  }}
                >
                  <em style={{ fontStyle: "italic", opacity: 0.85 }}>
                    Optional attr color:
                  </em>
                  <span
                    title="Optional (any)"
                    style={{
                      width: "16px",
                      height: "16px",
                      display: "inline-block",
                      background: "#374151",
                      border: "1px solid #1e252f",
                    }}
                  ></span>
                </span>
              </div>
            </div>
          )}
          <div
            id="dict-raw-coverage-wrapper"
            className="scroll-shadow"
            style={{
              overflow: "auto",
              maxWidth: "100%",
              padding: "6px",
              background: "#fff",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              position: "relative",
            }}
          >
            <table className="coverage-table">
              <thead>
                <tr>
                  <th className="sticky-col">Attribute</th>
                  {coverageRows.map((row) => (
                    <th
                      key={row.eventName}
                      className={`event-col${
                        eventMatches.hits.has(row.eventName) ? " event-hit" : ""
                      }${
                        eventMatches.focus === row.eventName
                          ? " event-focus"
                          : ""
                      }`}
                    >
                      {row.eventName}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredCategoriesBySearch.map(({ category, attributes }) => {
                  const isExpanded = expandedCategories.has(category);
                  const categoryKey = `category-${category}`;

                  return (
                    <>
                      <tr key={categoryKey} className="category-header-row">
                        <td
                          className="sticky-col category-header-cell"
                          style={{
                            background: "#e2e8f0",
                            fontWeight: 500,
                            fontSize: "12px",
                            padding: "2px 12px",
                            border: "none",
                            borderTop: "1px solid #cbd5e1",
                            borderBottom: "1px solid #cbd5e1",
                            cursor: "pointer",
                            userSelect: "none",
                            position: "sticky",
                            left: 0,
                            zIndex: 1,
                          }}
                          onClick={() => toggleCategory(category)}
                        >
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "8px",
                            }}
                          >
                            <span
                              style={{ fontSize: "10px", color: "#64748b" }}
                            >
                              {isExpanded ? "▼" : "▶"}
                            </span>
                            <span>{category}</span>
                            <span
                              className="gap-badge"
                              style={{
                                background: "#cbd5e1",
                                color: "#475569",
                                fontSize: "8px",
                                padding: "2px 4px",
                                borderRadius: "10px",
                                fontWeight: 500,
                              }}
                            >
                              {attributes.length}
                            </span>
                          </div>
                        </td>
                        {coverageRows.map((row) => (
                          <td
                            key={`${categoryKey}-${row.eventName}`}
                            style={{
                              background: "#e2e8f0",
                              border: "none",
                              borderTop: "1px solid #cbd5e1",
                              borderBottom: "1px solid #cbd5e1",
                              padding: 0,
                            }}
                          />
                        ))}
                      </tr>
                      {isExpanded &&
                        attributes.map((descriptor) => {
                          const sampleValues =
                            sampleValuesCache.get(
                              normalizeKeyValue(descriptor.name),
                            ) ?? [];

                          return (
                            <tr
                              key={descriptor.name}
                              className={
                                focusedAttribute === descriptor.name
                                  ? "row-focus-pulse"
                                  : undefined
                              }
                              data-row-type="dict"
                            >
                              <td className="sticky-col">
                                <AttributeTooltip
                                  attribute={descriptor.name}
                                  sampleValues={sampleValues}
                                >
                                  {renderHighlightedLabel(descriptor.name)}
                                </AttributeTooltip>
                              </td>
                              {coverageRows.map((row) => {
                                const cell = renderDictionaryCell(
                                  row.eventName,
                                  descriptor.name,
                                );
                                return (
                                  <td
                                    key={`${row.eventName}-${descriptor.name}`}
                                    style={cell.style}
                                    data-letter={cell.dataLetter}
                                    data-status={cell.dataStatus}
                                    title={cell.title}
                                  >
                                    {cell.letter}
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                    </>
                  );
                })}
                {hasExtraAttributes && (
                  <>
                    <tr className="category-header-row">
                      <td
                        className="sticky-col category-header-cell"
                        style={{
                          background: "#e2e8f0",
                          fontWeight: 500,
                          fontSize: "12px",
                          padding: "2px 12px",
                          border: "none",
                          borderTop: "1px solid #cbd5e1",
                          borderBottom: "1px solid #cbd5e1",
                          cursor: "pointer",
                          userSelect: "none",
                          position: "sticky",
                          left: 0,
                          zIndex: 1,
                        }}
                        onClick={() => toggleCategory("Extra Attributes")}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                          }}
                        >
                          <span style={{ fontSize: "10px", color: "#64748b" }}>
                            {expandedCategories.has("Extra Attributes")
                              ? "▼"
                              : "▶"}
                          </span>
                          <span>Extra Attributes</span>
                          <span
                            className="gap-badge"
                            style={{
                              background: "#cbd5e1",
                              color: "#475569",
                              fontSize: "8px",
                              padding: "2px 4px",
                              borderRadius: "10px",
                              fontWeight: 500,
                            }}
                          >
                            {filteredExtraAttributes.length}
                          </span>
                        </div>
                      </td>
                      {coverageRows.map((row) => (
                        <td
                          key={`extra-category-${row.eventName}`}
                          style={{
                            background: "#e2e8f0",
                            border: "none",
                            borderTop: "1px solid #cbd5e1",
                            borderBottom: "1px solid #cbd5e1",
                            padding: 0,
                          }}
                        />
                      ))}
                    </tr>
                    {expandedCategories.has("Extra Attributes") &&
                      filteredExtraAttributes.map((attribute) => {
                        const sampleValues =
                          sampleValuesCache.get(normalizeKeyValue(attribute)) ??
                          [];

                        return (
                          <tr key={`extra-${attribute}`} data-row-type="extra">
                            <td className="sticky-col">
                              <AttributeTooltip
                                attribute={attribute}
                                sampleValues={sampleValues}
                              >
                                {renderHighlightedLabel(attribute)}
                              </AttributeTooltip>
                            </td>
                            {coverageRows.map((row) => {
                              const cell = renderExtraCell(
                                row.eventName,
                                attribute,
                              );
                              return (
                                <td
                                  key={`extra-${row.eventName}-${attribute}`}
                                  style={cell.style}
                                  data-letter={cell.dataLetter}
                                  title={cell.title}
                                >
                                  {cell.letter}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                  </>
                )}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <section className="card" id="coverage-empty-state">
          <h2>Data Dictionary Coverage</h2>
          <div className="card-header-line"></div>
          <p className="desc">
            Upload both the dictionary and real-time CSV, then click “Run
            Analysis” to build coverage metrics.
          </p>
        </section>
      )}
    </div>
  );
};

type GapsPanelProps = {
  isVisible: boolean;
  analysisPerformed: boolean;
  gapData: GapData[];
  filteredGapRows: GapData[];
  activePlatform: "All" | Platform;
  gapSearch: string;
  onGapSearchChange: (value: string) => void;
  hidePartialGaps: boolean;
  onHidePartialChange: (value: boolean) => void;
  summary: GapSummary;
  dictionary: DictionaryParseResult | null;
  rawEvents: RawEvent[];
};

const GapsPanel = ({
  isVisible,
  analysisPerformed,
  gapData,
  filteredGapRows,
  activePlatform,
  gapSearch,
  onGapSearchChange,
  hidePartialGaps,
  onHidePartialChange,
  summary,
  dictionary,
  rawEvents,
}: GapsPanelProps) => {
  // Calculate missing events (events in dictionary but not in raw data)
  const missingEvents = useMemo(() => {
    if (!dictionary || !rawEvents || rawEvents.length === 0) return [];

    const normalizeKey = (value: string) =>
      value.toLowerCase().replace(/[^a-z0-9]/g, "");
    const rawEventNames = new Set(
      rawEvents.map((e) => normalizeKey(e.eventName || "")),
    );
    const dictEventNames = new Set<string>();

    // Collect all unique dictionary events
    dictionary.events.forEach((eventName) => {
      const normalizedEventName = normalizeKey(eventName);
      if (!rawEventNames.has(normalizedEventName)) {
        dictEventNames.add(eventName);
      }
    });

    return Array.from(dictEventNames).sort((a, b) => a.localeCompare(b));
  }, [dictionary, rawEvents]);

  return (
    <div
      id="gaps-panel"
      className={`tab-panel ${isVisible ? "active" : ""}`}
      role="tabpanel"
      aria-labelledby="gaps-tab"
    >
      {analysisPerformed && gapData.length > 0 ? (
        <section className="card fade-in" id="gaps-section">
          <h2
            style={{
              marginBottom: "10px",
              display: "flex",
              alignItems: "center",
              gap: "10px",
            }}
          >
            Events &amp; Attribute Gaps{" "}
            <span
              className="faded"
              style={{ fontSize: "12px", fontWeight: 500 }}
            >
              ({filteredGapRows.length} events)
            </span>
          </h2>
          <div className="card-header-line"></div>
          <div
            id="gaps-summary"
            className="faded"
            style={{ fontSize: "12px", margin: "4px 0 12px" }}
          >
            {summary.events > 0
              ? `${platformLabel(activePlatform)} | ${summary.events} events • ${summary.missing} required missing • ${summary.partial} partial`
              : `No gaps detected for ${platformLabel(activePlatform)}.`}
          </div>

          {/* Missing Events Section */}
          {missingEvents.length > 0 && (
            <div style={{ marginBottom: "24px" }}>
              <h3
                style={{
                  fontSize: "16px",
                  fontWeight: 600,
                  marginBottom: "12px",
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                }}
              >
                Missing Events
                <span
                  className="gap-badge missing"
                  style={{ fontSize: "11px" }}
                >
                  {missingEvents.length}
                </span>
              </h3>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                {missingEvents.map((eventName) => (
                  <span
                    key={eventName}
                    className="gap-badge"
                    style={{
                      background: "#fee2e2",
                      color: "#991b1b",
                      fontSize: "12px",
                    }}
                  >
                    {eventName}
                  </span>
                ))}
              </div>
            </div>
          )}

          <p className="desc" style={{ marginBottom: "16px" }}>
            Per-event list of attributes that are completely missing or only
            partially present across all raw occurrences. Optional attributes
            shown with italic style.
          </p>
          <div className="gaps-controls">
            C
            <input
              type="text"
              id="gaps-search"
              placeholder="Search event or attribute..."
              value={gapSearch}
              onChange={(event) => onGapSearchChange(event.target.value)}
            />
            <label
              className="switch small-switch"
              style={{ display: "flex", alignItems: "center", gap: "6px" }}
            >
              <input
                type="checkbox"
                checked={hidePartialGaps}
                onChange={(event) => onHidePartialChange(event.target.checked)}
              />
              <span>Hide Partial</span>
            </label>
          </div>
          <div
            id="gaps-events-wrapper"
            className="gaps-events-list"
            aria-live="polite"
          >
            {filteredGapRows.map((gap) => {
              const visiblePartial = hidePartialGaps ? [] : gap.partial;
              const hasMissing = gap.missing.length > 0;
              const hasPartial = visiblePartial.length > 0;

              return (
                <div
                  key={`${gap.platform}-${gap.eventName}`}
                  className="gap-event-card"
                >
                  <div className="gap-event-header">
                    <h3 className="gap-event-title">{gap.eventName}</h3>
                  </div>
                  {(hasMissing || hasPartial) && (
                    <div
                      className="gap-attributes-groups"
                      style={{
                        display: "grid",
                        gridTemplateColumns:
                          hasMissing && hasPartial ? "1fr 1fr" : "1fr",
                        gap: "16px",
                      }}
                    >
                      {hasMissing && (
                        <div className="gap-attr-group">
                          <h4 style={{ color: "#dc2626", marginBottom: "8px" }}>
                            Missing{" "}
                            <span className="gap-badge missing">
                              {gap.missing.length}
                            </span>
                          </h4>
                          <ul className="gap-attr-list">
                            {gap.missing.map((attribute) => (
                              <li
                                key={attribute.name}
                                className="gap-attr-item"
                              >
                                <span
                                  className={`gap-attr-name ${attribute.optional ? "optional" : ""}`}
                                >
                                  {attribute.name}
                                </span>
                                <span className="gap-attr-stats">
                                  {attribute.present}/{attribute.total}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {hasPartial && (
                        <div className="gap-attr-group">
                          <h4 style={{ color: "#ea580c", marginBottom: "8px" }}>
                            Partial{" "}
                            <span className="gap-badge partial">
                              {visiblePartial.length}
                            </span>
                          </h4>
                          <ul className="gap-attr-list">
                            {visiblePartial.map((attribute) => (
                              <li
                                key={attribute.name}
                                className="gap-attr-item"
                              >
                                <span
                                  className={`gap-attr-name ${attribute.optional ? "optional" : ""}`}
                                >
                                  {attribute.name}
                                </span>
                                <span className="gap-attr-stats">
                                  {attribute.present}/{attribute.total}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ) : (
        <section className="card" id="gaps-empty-state">
          <h2>Events &amp; Attribute Gaps</h2>
          <div className="card-header-line"></div>
          <p className="desc">
            After processing the CSVs you&apos;ll see platform-specific lists of
            missing and partial attributes for each event.
          </p>
        </section>
      )}
    </div>
  );
};

type SessionInfoPanelProps = {
  isOpen: boolean;
  onClose: () => void;
  sessionId: string | null;
  playbackSessionId: string | null;
  sections: SessionInfoSection[] | null;
};

const SessionInfoPanel = ({
  isOpen,
  onClose,
  sessionId,
  playbackSessionId,
  sections,
}: SessionInfoPanelProps) => {
  if (!isOpen) {
    return null;
  }

  const handlePanelClick = (event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
  };

  const readableSessionLabel = [sessionId, playbackSessionId]
    .filter((value) => Boolean(value))
    .join(" · ");

  return (
    <div className="session-info-overlay" role="presentation" onClick={onClose}>
      <div
        className="session-info-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-info-title"
        onClick={handlePanelClick}
      >
        <header className="session-info-header">
          <div>
            <h3 id="session-info-title">Session Details</h3>
            {readableSessionLabel && (
              <p className="session-info-subtitle">{readableSessionLabel}</p>
            )}
          </div>
          <button
            type="button"
            className="session-info-close"
            onClick={onClose}
            aria-label="Close session details"
          >
            ×
          </button>
        </header>
        <div className="session-info-body">
          {sections && sections.length > 0 ? (
            sections.map((section) => (
              <section key={section.title} className="session-info-section">
                <h4>{section.title}</h4>
                <dl>
                  {section.items.map((item) => (
                    <div key={item.label} className="session-info-row">
                      <dt>{item.label}</dt>
                      <dd>{item.value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))
          ) : (
            <p className="session-info-empty">
              No session metadata found for this selection.
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

export const AnalyticsApp = () => {
  const [activeTab, setActiveTab] = useState<ActiveTab>("dashboard");
  const [realTimeFile, setRealTimeFile] = useState<File | null>(null);
  const [dictionary, setDictionary] = useState<DictionaryParseResult | null>(
    null,
  );
  const [rawEvents, setRawEvents] = useState<RawEvent[]>([]);
  const [coverageByPlatform, setCoverageByPlatform] =
    useState<CoverageByPlatform>(resetCoverageState());
  const [gapData, setGapData] = useState<GapData[]>([]);
  const [playbackSessions, setPlaybackSessions] = useState<string[]>([]);
  const [sessionIds, setSessionIds] = useState<string[]>([]);
  const [actionHeader, setActionHeader] = useState("");
  const [isRealTimeDragging, setIsRealTimeDragging] = useState(false);
  const [selectedDashboardPlatform, setSelectedDashboardPlatform] = useState<
    "All" | Platform
  >("All");
  const [selectedDictionary, setSelectedDictionary] =
    useState<string>("v1.12-gray-media");
  const [selectedSessionId, setSelectedSessionId] = useState<string>("All");
  const [selectedPlaybackSessionId, setSelectedPlaybackSessionId] =
    useState<string>("All");
  const [attributeSearch, setAttributeSearch] = useState("");
  const [eventSearch, setEventSearch] = useState("");
  const [gapSearch, setGapSearch] = useState("");
  const [hidePartialGaps, setHidePartialGaps] = useState(false);
  const [isAttributesExpanded, setIsAttributesExpanded] = useState(false);
  const [analysisPerformed, setAnalysisPerformed] = useState(false);
  const [isSessionInfoOpen, setIsSessionInfoOpen] = useState(false);

  const realTimeInputRef = useRef<HTMLInputElement>(null);
  const analysisCacheRef = useRef<
    Map<
      string,
      {
        coverage: CoverageByPlatform;
        gapData: GapData[];
      }
    >
  >(new Map());

  // Load bundled dictionary by default
  useEffect(() => {
    loadBundledDictionary();
  }, [selectedDictionary]);

  // Auto-load demo.csv events for testing
  useEffect(() => {
    fetchTextOrThrow(`${import.meta.env.BASE_URL}dd/demo.csv`, "Failed to fetch demo events")
      .then(handleRealTimeContent)
      .catch((error) => console.warn("Demo CSV load skipped:", error));
  }, []);

  const resetAnalysis = useCallback(() => {
    analysisCacheRef.current.clear();
    setCoverageByPlatform(resetCoverageState());
    setGapData([]);
    setAnalysisPerformed(false);
  }, []);

  const handleDictionaryContent = useCallback(
    (text: string) => {
      try {
        const parsed = parseDictionary(text);
        setDictionary(parsed);
        resetAnalysis();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        alert(message);
      }
    },
    [resetAnalysis],
  );

  const handleRealTimeContent = useCallback(
    (text: string) => {
      try {
        const parsed = parseRealTimeData(text);
        setRawEvents(parsed.events);
        setPlaybackSessions(Array.from(parsed.playbackSessions));
        setSessionIds(Array.from(parsed.sessionIds));
        setActionHeader(parsed.actionHeader);
        resetAnalysis();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        alert(message);
      }
    },
    [resetAnalysis],
  );

  const handleRealTimeFile = useCallback(
    async (file: File) => {
      try {
        const text = await readFileText(file);
        setRealTimeFile(file);
        handleRealTimeContent(text);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        alert(message);
      }
    },
    [handleRealTimeContent],
  );

  const handleRealTimeDrop = useCallback(
    (event: DragEvent<HTMLButtonElement>) => {
      event.preventDefault();
      setIsRealTimeDragging(false);
      const file = fileFromDataTransfer(event.dataTransfer);
      file && handleRealTimeFile(file);
    },
    [handleRealTimeFile],
  );

  const loadBundledDictionary = useCallback(async () => {
    try {
      const text = await fetchTextOrThrow(
        `${DEFAULT_DICTIONARY_PATH}${selectedDictionary}.csv`,
        "Failed to fetch dictionary",
      );
      handleDictionaryContent(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      alert(message);
    }
  }, [handleDictionaryContent, selectedDictionary]);

  const coverageForPlatform = useMemo(
    () => coverageByPlatform[selectedDashboardPlatform],
    [coverageByPlatform, selectedDashboardPlatform],
  );

  const selectedDictionaryMap = useMemo(
    () => getDictionaryForPlatform(dictionary, selectedDashboardPlatform),
    [dictionary, selectedDashboardPlatform],
  );

  const platformMeta = useMemo(
    () => formatPlatformMeta(dictionary, selectedDashboardPlatform),
    [dictionary, selectedDashboardPlatform],
  );

  const attributeGroups = useMemo(
    () =>
      dictionary && isAttributesExpanded
        ? buildAttributeGroups(dictionary, selectedDashboardPlatform)
        : [],
    [dictionary, isAttributesExpanded, selectedDashboardPlatform],
  );

  const filteredGapRows = useMemo(
    () => filterGapRows(gapData, selectedDashboardPlatform, gapSearch),
    [gapData, selectedDashboardPlatform, gapSearch],
  );

  const gapSummary = useMemo(
    () => summarizeGapData(gapData, selectedDashboardPlatform),
    [gapData, selectedDashboardPlatform],
  );

  const copyPlaybackSessions = useCallback(() => {
    navigator.clipboard
      .writeText(playbackSessions.join("\n"))
      .catch(() => alert("Failed to copy playback sessions"));
  }, [playbackSessions]);

  // Filter raw events based on session selections for analysis
  const filteredEventsForAnalysis = useMemo(() => {
    const SESSION_KEYS = ["sessionId", "session_id", "sessionid"];
    const PLAYBACK_KEYS = [
      "playbackSessionId",
      "playback_session_id",
      "playbacksessionid",
    ];
    const normalizeKey = (value: string) =>
      value.toLowerCase().replace(/[^a-z0-9]/g, "");

    return rawEvents.filter((event) => {
      // Filter by session ID
      if (selectedSessionId !== "All") {
        const sessionKey = Object.keys(event).find((key) =>
          SESSION_KEYS.some((sk) => normalizeKey(sk) === normalizeKey(key)),
        );
        if (!sessionKey || event[sessionKey] !== selectedSessionId) {
          return false;
        }
      }

      // Filter by playback session ID
      if (selectedPlaybackSessionId !== "All") {
        const playbackKey = Object.keys(event).find((key) =>
          PLAYBACK_KEYS.some((pk) => normalizeKey(pk) === normalizeKey(key)),
        );
        if (!playbackKey || event[playbackKey] !== selectedPlaybackSessionId) {
          return false;
        }
      }

      return true;
    });
  }, [rawEvents, selectedSessionId, selectedPlaybackSessionId]);

  const canShowSessionInfo =
    (selectedSessionId !== "All" || selectedPlaybackSessionId !== "All") &&
    filteredEventsForAnalysis.length > 0;

  useEffect(() => {
    if (!canShowSessionInfo) {
      setIsSessionInfoOpen(false);
    }
  }, [canShowSessionInfo]);

  useEffect(() => {
    if (!isSessionInfoOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsSessionInfoOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isSessionInfoOpen]);

  const sessionInfoSections = useMemo<SessionInfoSection[] | null>(() => {
    if (!canShowSessionInfo || filteredEventsForAnalysis.length === 0) {
      return null;
    }

    const valueByNormalizedKey = new Map<string, string>();
    filteredEventsForAnalysis.forEach((event) => {
      Object.entries(event).forEach(([key, rawValue]) => {
        const value =
          typeof rawValue === "string" ? rawValue.trim() : String(rawValue);
        if (!value) return;
        const normalized = normalizeKeyValue(key);
        if (!normalized) return;
        if (!valueByNormalizedKey.has(normalized)) {
          valueByNormalizedKey.set(normalized, value);
        }
      });
    });

    const getValue = (candidates: string[]): string | null => {
      for (const candidate of candidates) {
        const normalized = normalizeKeyValue(candidate);
        const value = valueByNormalizedKey.get(normalized);
        if (value) {
          return value;
        }
      }
      return null;
    };

    const addItem = (
      items: Array<{ label: string; value: string }>,
      label: string,
      candidates: string[],
    ) => {
      const value = getValue(candidates);
      if (value) {
        items.push({ label, value });
      }
    };

    const sections: SessionInfoSection[] = [];

    const getDurationValue = () => {
      const rawValue =
        getValue([
          "sessionduration",
          "session_duration",
          "duration",
          "sessionlength",
          "watchduration",
          "totaltime",
          "totaltimewatched",
          "sessiondurationms",
        ]) ?? null;
      if (!rawValue) return null;
      const trimmed = rawValue.trim();
      if (!trimmed) return null;
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric) && numeric >= 0) {
        // Assume large numbers are in milliseconds and small numbers are in seconds.
        const seconds = numeric > 86400 ? numeric / 1000 : numeric;
        const totalSeconds = Math.round(seconds);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const secs = totalSeconds % 60;
        const segments = [
          hours > 0 ? String(hours).padStart(2, "0") : null,
          String(minutes).padStart(2, "0"),
          String(secs).padStart(2, "0"),
        ].filter(Boolean);
        return segments.join(":");
      }
      return trimmed;
    };

    const overviewItems: Array<{ label: string; value: string }> = [];
    if (selectedSessionId !== "All") {
      overviewItems.push({ label: "Session ID", value: selectedSessionId });
    }
    if (selectedPlaybackSessionId !== "All") {
      overviewItems.push({
        label: "Playback Session",
        value: selectedPlaybackSessionId,
      });
    }
    overviewItems.push({
      label: "Duration",
      value: getDurationValue() ?? "Not available",
    });
    sections.push({ title: "Overview", items: overviewItems });

    const viewerItems: Array<{ label: string; value: string }> = [];
    addItem(viewerItems, "Viewer ID", ["viewerId", "viewer_id", "viewer"]);
    addItem(viewerItems, "Client ID", ["clientId", "client_id"]);
    addItem(viewerItems, "Account", ["accountid", "account_id", "account"]);
    if (viewerItems.length) {
      sections.push({ title: "Viewer Metadata", items: viewerItems });
    }

    const metricsItems: Array<{ label: string; value: string }> = [];
    addItem(metricsItems, "Avg. % Complete", [
      "avg%complete",
      "avgpercentcomplete",
      "avg_percent_complete",
      "avgpercentcompletesession",
    ]);
    addItem(metricsItems, "VST", ["vst", "videostartuptime", "sessionvst"]);
    addItem(metricsItems, "Rebuff", ["rebuff", "rebuffer", "rebuffrate"]);
    addItem(metricsItems, "Avg. Peak Bitrate", [
      "avgpeakbitrate",
      "avg_peak_bitrate",
    ]);
    addItem(metricsItems, "CIRR", ["cirr"]);
    addItem(metricsItems, "VRT", ["vrt"]);
    if (metricsItems.length) {
      sections.push({ title: "Viewing Experience", items: metricsItems });
    }

    if (selectedPlaybackSessionId !== "All") {
      const contentItems: Array<{ label: string; value: string }> = [];
      addItem(contentItems, "Title", [
        "assetname",
        "title",
        "programtitle",
        "contentname",
      ]);
      const formatRaw = getValue([
        "contentcategory",
        "content_category",
        "format",
        "islive",
        "live",
      ]);
      if (formatRaw) {
        const normalized = formatRaw.trim().toLowerCase();
        let formatted = formatRaw;
        if (["true", "1", "live", "livestream"].includes(normalized)) {
          formatted = "Live";
        } else if (
          ["false", "0", "vod", "ondemand", "on-demand"].includes(normalized)
        ) {
          formatted = "VOD";
        }
        contentItems.push({ label: "Format", value: formatted });
      }
      addItem(contentItems, "Content Type", [
        "contenttype",
        "content_type",
        "programtype",
        "type",
      ]);
      addItem(contentItems, "Playback URL", [
        "playbackurl",
        "streamurl",
        "url",
        "cdnurl",
      ]);
      if (contentItems.length) {
        sections.push({ title: "Content", items: contentItems });
      }
    }

    const locationItems: Array<{ label: string; value: string }> = [];
    addItem(locationItems, "Location", ["location"]);
    addItem(locationItems, "City", ["city"]);
    addItem(locationItems, "Region", ["state", "region", "province"]);
    addItem(locationItems, "Country", ["country"]);
    addItem(locationItems, "ISP", ["isp", "internetserviceprovider"]);
    addItem(locationItems, "ASN", ["asn"]);
    addItem(locationItems, "IPv4", ["ipv4", "ipaddress", "ip"]);
    addItem(locationItems, "IPv6", ["ipv6"]);
    if (locationItems.length) {
      sections.push({ title: "Location & Network", items: locationItems });
    }

    const deviceItems: Array<{ label: string; value: string }> = [];
    addItem(deviceItems, "Browser", ["browsername", "browser"]);
    addItem(deviceItems, "Browser Version", ["browserversion"]);
    addItem(deviceItems, "Device Type", [
      "devicehardwaretype",
      "devicetype",
      "device",
    ]);
    addItem(deviceItems, "OS", ["operatingsystem", "os"]);
    if (deviceItems.length) {
      sections.push({ title: "Device Metadata", items: deviceItems });
    }

    return sections;
  }, [
    canShowSessionInfo,
    filteredEventsForAnalysis,
    selectedPlaybackSessionId,
    selectedSessionId,
  ]);

  const runAnalysis = useCallback(() => {
    try {
      ensureAnalysisInputs(dictionary, filteredEventsForAnalysis);

      const safeDictionary = dictionary!;
      const cacheKey = `${selectedSessionId}::${selectedPlaybackSessionId}`;
      const cached = analysisCacheRef.current.get(cacheKey);
      if (cached) {
        setCoverageByPlatform(cached.coverage);
        setGapData(cached.gapData);
        setAnalysisPerformed(true);
        return;
      }

      const nextCoverage: CoverageByPlatform = {
        All: buildCoverageData(
          safeDictionary.all,
          filteredEventsForAnalysis,
          actionHeader,
        ),
        Web: buildCoverageData(
          safeDictionary.web,
          filteredEventsForAnalysis,
          actionHeader,
        ),
        Mobile: buildCoverageData(
          safeDictionary.mobile,
          filteredEventsForAnalysis,
          actionHeader,
        ),
        Roku: buildCoverageData(
          safeDictionary.roku,
          filteredEventsForAnalysis,
          actionHeader,
        ),
      };

      const gaps = buildGapData(
        {
          web: safeDictionary.web,
          mobile: safeDictionary.mobile,
          roku: safeDictionary.roku,
        },
        filteredEventsForAnalysis,
      );

      setCoverageByPlatform(nextCoverage);
      setGapData(gaps);
      analysisCacheRef.current.set(cacheKey, {
        coverage: nextCoverage,
        gapData: gaps,
      });
      setAnalysisPerformed(true);
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error));
    }
  }, [
    dictionary,
    filteredEventsForAnalysis,
    actionHeader,
    selectedSessionId,
    selectedPlaybackSessionId,
  ]);

  const dictLoaded = Boolean(dictionary);
  const canProcess = dictLoaded && rawEvents.length > 0;
  const showPlaybackSessions = playbackSessions.length > 0;

  // Re-run analysis when session filters change (if analysis was already performed)
  useEffect(() => {
    if (
      analysisPerformed &&
      dictionary &&
      filteredEventsForAnalysis.length > 0
    ) {
      runAnalysis();
    }
  }, [selectedSessionId, selectedPlaybackSessionId]); // Only depend on filter changes, not runAnalysis

  const handleRealTimeBrowse = () => realTimeInputRef.current?.click();

  const handleRealTimeFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    file && handleRealTimeFile(file);
  };

  // Compute available session IDs based on current filters
  const availableSessionIds = useMemo(() => {
    if (selectedPlaybackSessionId === "All") return sessionIds;

    const SESSION_KEYS = ["sessionId", "session_id", "sessionid"];
    const PLAYBACK_KEYS = [
      "playbackSessionId",
      "playback_session_id",
      "playbacksessionid",
    ];
    const normalizeKey = (value: string) =>
      value.toLowerCase().replace(/[^a-z0-9]/g, "");

    const filteredEvents = rawEvents.filter((event) => {
      const playbackKey = Object.keys(event).find((key) =>
        PLAYBACK_KEYS.some((pk) => normalizeKey(pk) === normalizeKey(key)),
      );
      return playbackKey && event[playbackKey] === selectedPlaybackSessionId;
    });

    const sessionSet = new Set<string>();
    filteredEvents.forEach((event) => {
      const sessionKey = Object.keys(event).find((key) =>
        SESSION_KEYS.some((sk) => normalizeKey(sk) === normalizeKey(key)),
      );
      if (sessionKey && event[sessionKey]) {
        sessionSet.add(String(event[sessionKey]));
      }
    });
    return Array.from(sessionSet);
  }, [rawEvents, selectedPlaybackSessionId, sessionIds]);

  // Compute available playback session IDs based on current filters
  const availablePlaybackSessions = useMemo(() => {
    if (selectedSessionId === "All") return playbackSessions;

    const SESSION_KEYS = ["sessionId", "session_id", "sessionid"];
    const PLAYBACK_KEYS = [
      "playbackSessionId",
      "playback_session_id",
      "playbacksessionid",
    ];
    const normalizeKey = (value: string) =>
      value.toLowerCase().replace(/[^a-z0-9]/g, "");

    const filteredEvents = rawEvents.filter((event) => {
      const sessionKey = Object.keys(event).find((key) =>
        SESSION_KEYS.some((sk) => normalizeKey(sk) === normalizeKey(key)),
      );
      return sessionKey && event[sessionKey] === selectedSessionId;
    });

    const playbackSet = new Set<string>();
    filteredEvents.forEach((event) => {
      const playbackKey = Object.keys(event).find((key) =>
        PLAYBACK_KEYS.some((pk) => normalizeKey(pk) === normalizeKey(key)),
      );
      if (playbackKey && event[playbackKey]) {
        playbackSet.add(String(event[playbackKey]));
      }
    });
    return Array.from(playbackSet);
  }, [rawEvents, selectedSessionId, playbackSessions]);

  return (
    <div className="analytics-app">
      <div className="app-container">
        <nav className="tabs" aria-label="Main Views">
          <button
            className={`tab ${activeTab === "dashboard" ? "active" : ""}`}
            onClick={() => setActiveTab("dashboard")}
            role="tab"
            aria-selected={activeTab === "dashboard"}
          >
            Dashboard
          </button>
          <button
            className={`tab ${activeTab === "gaps" ? "active" : ""}`}
            onClick={() => setActiveTab("gaps")}
            role="tab"
            aria-selected={activeTab === "gaps"}
          >
            Events &amp; Attribute Gaps
          </button>
        </nav>

        <section className="card fade-in" id="input-files-section">
          <h2>Input Configuration</h2>
          <div className="card-header-line"></div>

          <div className="input-config-stack">
            {/* Data Dictionary */}
            <div className="input-group">
              <label className="input-label" htmlFor="data-dictionary-select">
                <span className="input-label-text">Data Dictionary</span>
              </label>
              <div className="select-shell">
                <select
                  id="data-dictionary-select"
                  className="fancy-select"
                  value={selectedDictionary}
                  onChange={(event) =>
                    setSelectedDictionary(event.target.value)
                  }
                >
                  <option value="v1.12-gray-media">Gray Media v1.12</option>
                  <option value="v1.12-amd-comedytv">AMD ComedyTV v1.12</option>
                </select>
              </div>
            </div>

            {/* Platform */}
            <div className="input-group">
              <label className="input-label" htmlFor="platform-select">
                <span className="input-label-text">Platform</span>
              </label>
              <div className="select-shell">
                <select
                  id="platform-select"
                  className="fancy-select"
                  value={selectedDashboardPlatform}
                  onChange={(event) =>
                    setSelectedDashboardPlatform(
                      event.target.value as "All" | Platform,
                    )
                  }
                >
                  <option value="All">All Platforms</option>
                  <option value="Web">Web</option>
                  <option value="Mobile">Mobile</option>
                  <option value="Roku">Roku</option>
                </select>
              </div>
            </div>

            {/* Analytics Data */}
            <div className="input-group">
              <label className="input-label" htmlFor="analytics-data">
                <span className="input-label-text">Analytics Data</span>
              </label>
              <div className="file-upload-compact">
                <button
                  type="button"
                  className={`file-drop-compact ${isRealTimeDragging ? "dragover" : ""}`}
                  onClick={handleRealTimeBrowse}
                  onDrop={handleRealTimeDrop}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setIsRealTimeDragging(true);
                  }}
                  onDragLeave={() => setIsRealTimeDragging(false)}
                >
                  {realTimeFile ? (
                    <>
                      ⚡{" "}
                      <span className="file-name-display">
                        {realTimeFile.name}
                      </span>
                    </>
                  ) : (
                    "⚡ Drop CSV or click to browse"
                  )}
                </button>
                <input
                  type="file"
                  id="analytics-data"
                  name="analytics-data"
                  accept=".csv, text/csv"
                  className="native-file-input"
                  ref={realTimeInputRef}
                  onChange={handleRealTimeFileInput}
                />
              </div>
            </div>

            {/* Process Button */}
            <div className="input-group">
              <div className="process-section">
                <button
                  onClick={runAnalysis}
                  disabled={!canProcess}
                  id="btn-process"
                  className="primary-large"
                >
                  Run Analysis
                </button>
              </div>
            </div>
          </div>
        </section>

        {dictLoaded && (
          <section className="card fade-in" id="attributes-per-event-section">
            <h2
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <span>Attributes Per Event</span>
              <button
                type="button"
                className="btn-secondary tiny"
                onClick={() => setIsAttributesExpanded((expanded) => !expanded)}
              >
                {isAttributesExpanded ? "Collapse" : "Expand"}
              </button>
            </h2>
            <div className="card-header-line"></div>
            <p className="desc">
              Shows attributes where the cell contains 'Y' (present for that
              event). Optional (O) attributes are noted.
            </p>
            {isAttributesExpanded && (
              <>
                <div
                  className="controls-inline"
                  style={{ marginBottom: "15px" }}
                >
                  <div className="filter-group">
                    <label
                      htmlFor="platform-view-select"
                      style={{ fontWeight: 600 }}
                    >
                      Platform:
                    </label>
                    <select
                      id="platform-view-select"
                      value={selectedDashboardPlatform}
                      onChange={(event) =>
                        setSelectedDashboardPlatform(
                          event.target.value as "All" | Platform,
                        )
                      }
                    >
                      <option value="All">All</option>
                      <option value="Web">Web</option>
                      <option value="Mobile">Mobile</option>
                      <option value="Roku">Roku</option>
                    </select>
                    <span style={{ color: "#555", marginLeft: "8px" }}>
                      {platformMeta}
                    </span>
                  </div>
                </div>
                <div id="attributes-per-event">
                  {attributeGroups.map((group) => (
                    <div
                      key={group.eventName}
                      className="event-attributes-group"
                      style={{ marginBottom: "24px" }}
                    >
                      <h3 style={{ marginBottom: "8px", fontSize: "16px" }}>
                        {group.eventName} — {group.requiredCount} required,{" "}
                        {group.optionalCount} optional
                      </h3>
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: "6px",
                        }}
                      >
                        {group.attributes.map((attribute) => (
                          <span
                            key={attribute.name}
                            className={`badge ${attribute.status === "O" ? "opt" : "req"}`}
                            style={{
                              fontSize: "11px",
                              opacity: attribute.status === "O" ? 0.75 : 1,
                            }}
                            title={
                              attribute.status === "O"
                                ? "Optional attribute"
                                : "Required attribute"
                            }
                          >
                            {attribute.name}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>
        )}

        <CoveragePanel
          isVisible={activeTab === "dashboard"}
          analysisPerformed={analysisPerformed}
          coverageRows={coverageForPlatform}
          selectedDictionaryMap={selectedDictionaryMap}
          attributeSearch={attributeSearch}
          onAttributeSearchChange={setAttributeSearch}
          eventSearch={eventSearch}
          onEventSearchChange={setEventSearch}
          showPlaybackSessions={showPlaybackSessions}
          playbackSessions={availablePlaybackSessions}
          sessionIds={availableSessionIds}
          selectedSessionId={selectedSessionId}
          onSessionIdChange={setSelectedSessionId}
          selectedPlaybackSessionId={selectedPlaybackSessionId}
          onPlaybackSessionIdChange={setSelectedPlaybackSessionId}
          copyPlaybackSessions={copyPlaybackSessions}
          rawEvents={filteredEventsForAnalysis}
          canShowSessionInfo={canShowSessionInfo && analysisPerformed}
          onOpenSessionInfo={() => setIsSessionInfoOpen(true)}
        />

        <GapsPanel
          isVisible={activeTab === "gaps"}
          analysisPerformed={analysisPerformed}
          gapData={gapData}
          filteredGapRows={filteredGapRows}
          activePlatform={selectedDashboardPlatform}
          gapSearch={gapSearch}
          onGapSearchChange={setGapSearch}
          hidePartialGaps={hidePartialGaps}
          onHidePartialChange={setHidePartialGaps}
          summary={gapSummary}
          dictionary={dictionary}
          rawEvents={rawEvents}
        />
        <SessionInfoPanel
          isOpen={isSessionInfoOpen}
          onClose={() => setIsSessionInfoOpen(false)}
          sessionId={selectedSessionId !== "All" ? selectedSessionId : null}
          playbackSessionId={
            selectedPlaybackSessionId !== "All"
              ? selectedPlaybackSessionId
              : null
          }
          sections={sessionInfoSections}
        />
      </div>
    </div>
  );
};
