import { describe, expect, test } from "vitest";

import {
  type AcceptanceChoicePorts,
  answerChoice,
} from "../../tests/fixtures/acceptance-choice.js";

/**
 * Answering a choice control whose popup arrives after the click.
 *
 * `Select` portals its popup, so the list is mounted in a commit later than
 * the one the click schedules. A driver that counted the options in the same
 * breath as the click counted a document the popup had not reached, read the
 * none it got back as "this control offers nothing", dismissed it, and left a
 * required select unanswered — which the surface reported as a text control
 * that would accept no value, naming a field the driver had never typed into.
 *
 * The popup below commits on being settled rather than on being opened, which
 * is what the real one does; a step order that reads the count before then
 * gets the same none, and fails here instead of in a browser.
 */

/** A popup that lists nothing until it has been given the chance to commit. */
function scriptedChoice(lists: number): {
  order: string[];
  ports: AcceptanceChoicePorts;
} {
  const order: string[] = [];
  let committed = false;

  return {
    order,
    ports: {
      choose: async () => {
        order.push("choose");
      },
      closed: async () => {
        order.push("closed");
      },
      dismiss: async () => {
        order.push("dismiss");
      },
      listed: async () => {
        order.push("listed");

        return committed ? lists : 0;
      },
      open: async () => {
        order.push("open");
      },
      settled: async () => {
        order.push("settled");
        committed = true;
      },
    },
  };
}

describe("answering one choice control", () => {
  test("waits for the popup to settle before counting what it lists", async () => {
    const scripted = scriptedChoice(3);

    await answerChoice(scripted.ports);

    // The whole defect, in the order alone: a count taken before the popup
    // settles is a count of a popup that is not there, and the choice is
    // abandoned as an empty one.
    expect(scripted.order).toEqual([
      "open",
      "settled",
      "listed",
      "choose",
      "closed",
    ]);
  });

  test("dismisses a popup that settles with nothing to take", async () => {
    // Planted the other way, because a step that always chose would satisfy
    // the assertion above and would then click an option no popup lists.
    const scripted = scriptedChoice(0);

    await answerChoice(scripted.ports);

    expect(scripted.order).toEqual([
      "open",
      "settled",
      "listed",
      "dismiss",
      "closed",
    ]);
  });
});
