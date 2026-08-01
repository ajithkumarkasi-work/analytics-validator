import Papa from 'papaparse'

export const parseCSV = (text: string): string[][] => {
  if (!text.trim()) {
    return []
  }

  const parsed = Papa.parse<string[]>(text, {
    dynamicTyping: false,
    skipEmptyLines: true
  })

  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors[0].message)
  }

  return parsed.data
}
