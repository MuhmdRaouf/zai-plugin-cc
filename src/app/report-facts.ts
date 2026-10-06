import { z } from "zod";

/** The parts of a worker report that every built-in contract shares; custom reports may have them too. */
const Shared = z.object({
  summary: z.string().optional().catch(undefined),
  open_items: z.array(z.string()).optional().catch(undefined),
  tests_added: z.array(z.string()).optional().catch(undefined),
});

export interface ReportFacts {
  readonly summary?: string;
  readonly openItems: readonly string[];
  readonly testsAdded: readonly string[];
}

/** Summary, open items and added tests of a report of any shape; whatever is missing or malformed is left out. */
export function reportFacts(report: unknown): ReportFacts {
  const parsed = Shared.safeParse(report);
  if (!parsed.success) return { openItems: [], testsAdded: [] };
  const summary = parsed.data.summary?.trim();
  return {
    ...(summary === undefined || summary === "" ? {} : { summary }),
    openItems: parsed.data.open_items ?? [],
    testsAdded: parsed.data.tests_added ?? [],
  };
}
