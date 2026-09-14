import { describe, expect, it } from "vitest";
import { describeSchedule } from "../src/schedule/describe.js";

describe("describeSchedule", () => {
  it("reads a stepped night window as the queue's sentence", () => {
    expect(describeSchedule("*/10 1-5 * * *")).toBe("Every 10 minutes between 01:00 and 05:59, every day");
  });

  it("reads common shapes as sentences", () => {
    expect(describeSchedule("* * * * *")).toBe("Every minute, every day");
    expect(describeSchedule("*/15 * * * *")).toBe("Every 15 minutes, every day");
    expect(describeSchedule("0 * * * *")).toBe("Every hour on the hour, every day");
    expect(describeSchedule("30 * * * *")).toBe("Every hour at :30, every day");
    expect(describeSchedule("30 9 * * *")).toBe("At 09:30, every day");
    expect(describeSchedule("*/10 9 * * *")).toBe("Every 10 minutes between 09:00 and 09:59, every day");
    expect(describeSchedule("0 9-17 * * *")).toBe("At :00 past each hour between 09:00 and 17:59, every day");
    expect(describeSchedule("0 9,17 * * *")).toBe("At 09:00 and 17:00, every day");
    expect(describeSchedule("15,45 9 * * *")).toBe("At 09:15 and 09:45, every day");
    expect(describeSchedule("5,25 * * * *")).toBe("At :05 and :25 past every hour, every day");
    expect(describeSchedule("*/20 1,3,5 * * *")).toBe("Every 20 minutes during hours 01, 03, and 05, every day");
  });

  it("does not call a non-divisor step every-N: */40 and */45 fire :00/:N then :00 again soon", () => {
    expect(describeSchedule("*/40 * * * *")).toBe("At :00 and :40 past every hour, every day");
    expect(describeSchedule("*/45 * * * *")).toBe("At :00 and :45 past every hour, every day");
    // Too many marks to list honestly: fall back to the raw expression.
    expect(describeSchedule("*/7 * * * *")).toBeNull();
  });

  it("reads day restrictions honestly", () => {
    expect(describeSchedule("0 9 * * 1-5")).toBe("At 09:00, on weekdays");
    expect(describeSchedule("0 9 * * 0,6")).toBe("At 09:00, on weekends");
    expect(describeSchedule("0 9 * * 1,3,5")).toBe("At 09:00, on Mon, Wed, and Fri");
    expect(describeSchedule("0 0 1 * *")).toBe("At 00:00, on day-of-month 1");
    expect(describeSchedule("0 0 1,15 * *")).toBe("At 00:00, on day-of-month 1 and 15");
    expect(describeSchedule("0 0 * 6 *")).toBe("At 00:00, every day in Jun");
    // POSIX OR: dom and dow both restricted means either match fires.
    expect(describeSchedule("0 0 1 * 1")).toBe("At 00:00, on day-of-month 1 or Mon");
  });

  it("returns null for shapes it cannot describe honestly", () => {
    expect(describeSchedule("not a cron")).toBeNull();
    expect(describeSchedule("1-59/2 * * * *")).toBeNull();
    expect(describeSchedule("5,10,15,20,25 * * * *")).toBeNull();
    expect(describeSchedule("0 0 * *")).toBeNull();
  });
});
