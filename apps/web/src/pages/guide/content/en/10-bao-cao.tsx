/*
 * English edition, chapter 10-bao-cao (US-119). Converted from the BA's static page
 * `public/guide/en/10-bao-cao.html`.
 */
import {
  ChapterEyebrow,
  ChapterIntro,
  ChapterSummary,
  CheckUnderstanding,
  DocTable,
  InstructionList,
  Lead,
  Section,
  TroubleshootList,
} from '../../ui/parts'

export default function Chapter() {
  return (
    <>
      <ChapterIntro id="chapter-10">
        <div>
          <ChapterEyebrow>PART 10 · REPORTS</ChapterEyebrow>
          <h2>Read progress from the correct data source</h2>
          <Lead>
            Rova provides three read-only reports: <strong>Iteration Burndown</strong> tracks
            remaining work each day, <strong>Velocity</strong> compares results across completed
            Iterations and <strong>Team Capacity</strong> summarizes Capacity together with current
            Task hours.
          </Lead>
        </div>
        <ChapterSummary aria-label="After this chapter you will be able to">
          <strong>After this chapter, you will be able to</strong>
          <ul>
            <li>Select the correct report for the question to answer.</li>
            <li>Read Burndown without confusing Hours with Points.</li>
            <li>Distinguish between Accepted During, After and Not Accepted.</li>
            <li>Read Capacity, Estimate, ToDo and Actual by Team.</li>
            <li>Recognize zeros, empty data and missing history.</li>
          </ul>
        </ChapterSummary>
      </ChapterIntro>
      <Section
        id="chon-bao-cao"
        number="10.1"
        title="Select the correct report"
        lead="Each report answers a question and uses a different data source."
      >
        <DocTable>
          <thead>
            <tr>
              <th>When you need to know</th>
              <th>Select Type</th>
              <th>Time range</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Is the remaining work decreasing as planned?</strong>
              </td>
              <td>Iteration Burndown</td>
              <td>One selected Iteration.</td>
            </tr>
            <tr>
              <td>
                <strong>How many Points does the Team usually complete on time?</strong>
              </td>
              <td>Velocity</td>
              <td>The 5 or 10 most recently finished Iterations.</td>
            </tr>
            <tr>
              <td>
                <strong>How are Capacity and current Task hours allocated?</strong>
              </td>
              <td>Team Capacity</td>
              <td>One selected Iteration.</td>
            </tr>
          </tbody>
        </DocTable>
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Select Project and Team</strong>
              <p>
                Reports uses the context selector in the top bar; there is no separate Project/Team
                filter inside the page.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Open Reports</strong>
              <p>
                Select Type next to the Reports heading: Iteration Burndown, Velocity or Team
                Capacity.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Select the time range</strong>
              <p>
                Burndown and Team Capacity use the Iteration picker. Velocity uses Window = Last 5
                or Last 10 sprints.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Read data status first</strong>
              <p>
                If the page reports no history or no data, resolve the cause before using the data.
              </p>
            </div>
          </li>
        </InstructionList>
        <p>
          Reports are only available to Workspace Admins and assigned Project Admins. Editors and
          accounts without Project rights cannot open Reports. All reports are{' '}
          <strong>read-only</strong>.
        </p>
      </Section>
      <Section
        id="doc-iteration-burndown"
        number="10.2"
        title="Read Iteration Burndown"
        lead="Burndown combines Task hours and US/DE Points on two different axes."
      >
        <DocTable>
          <thead>
            <tr>
              <th>Data series</th>
              <th>Unit</th>
              <th>How to read</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Task To Do</strong>
              </td>
              <td>Hours</td>
              <td>
                Total Task ToDo at the end of each day. The value should gradually decrease as work
                progresses.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Ideal</strong>
              </td>
              <td>Hours</td>
              <td>
                The ideal burndown line from the total Task Estimate when the Iteration starts to 0
                on the last working day.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Accepted</strong>
              </td>
              <td>Points</td>
              <td>
                Cumulative Plan Estimate of US/DE that reached Accepted or Release, as of each day.
              </td>
            </tr>
          </tbody>
        </DocTable>
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Select Iteration</strong>
              <p>
                Use the previous button, the Iteration list and the next button. Confirm the correct
                date range is displayed.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Compare ToDo with Ideal</strong>
              <p>
                Remaining To Do higher than Ideal on the latest snapshot date is read as Behind
                plan; equal or lower is On track.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Read Accepted Points separately</strong>
              <p>Accepted uses the Points axis. Do not subtract Points directly from ToDo Hours.</p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Check continuity</strong>
              <p>
                Burndown uses end-of-day snapshots. Dates missing history must be displayed as
                having no data, not automatically bridged or rebuilt from today's value.
              </p>
            </div>
          </li>
        </InstructionList>
        <p>
          <strong>Burndown history is frozen.</strong> Changing today's To Do, Estimate, or scope
          does not rewrite the previous day's snapshot. Ideal also does not change when Tasks are
          added or re-estimated after the Iteration starts.
        </p>
        <p>
          When an Iteration has no daily history, the report shows{' '}
          <strong>No burndown to show</strong> and does not draw Ideal if the start baseline has not
          been recorded.
        </p>
      </Section>
      <Section
        id="doc-velocity"
        number="10.3"
        title="Read Velocity"
        lead="Velocity separates work accepted on time, accepted late, and not yet accepted."
      >
        <DocTable>
          <thead>
            <tr>
              <th>Group</th>
              <th>Conditions</th>
              <th>Does it count towards Velocity?</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Accepted During Iteration</strong>
              </td>
              <td>US/DE reaches Accepted or Release no later than the Iteration end date.</td>
              <td>Yes. This is the source of Trend and average values.</td>
            </tr>
            <tr>
              <td>
                <strong>Accepted After Iteration</strong>
              </td>
              <td>US/DE is accepted after the Iteration has ended.</td>
              <td>No; used for context only.</td>
            </tr>
            <tr>
              <td>
                <strong>Not Accepted</strong>
              </td>
              <td>US/DE is not currently in Accepted or Release.</td>
              <td>No; used for context only.</td>
            </tr>
          </tbody>
        </DocTable>
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Select Window</strong>
              <p>
                Last 5 sprints focus on the recent trend; Last 10 sprints give a more stable picture
                when enough data is available.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Read each stacked column</strong>
              <p>
                The three parts add up to all Points of the US/DE currently assigned to that
                Iteration.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Read Trend and Averages</strong>
              <p>
                Trend, Last 3, Best 3 and Worst 3 count only Accepted During. Accepted After doesn't
                make Velocity better.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Check the number of available Iterations</strong>
              <p>
                When there are fewer than three Iterations, the report uses the entire available
                sample and must show the actual sample size.
              </p>
            </div>
          </li>
        </InstructionList>
        <p>
          <strong>Velocity is a classification based on current data.</strong> Moving US/DE into or
          out of an old Iteration, changing Plan Estimate or reopening items can cause the old chart
          to change. This report does not use frozen snapshots like Burndown.
        </p>
        <p>
          Accepted or Release missing acceptedDate is a data quality error. Don't guess whether the
          item belongs to During or After.
        </p>
      </Section>
      <Section
        id="doc-team-capacity-report"
        number="10.4"
        title="Read Team Capacity"
        lead="The report uses the same Capacity and Task hour sources as Track → Team Status."
      >
        <DocTable>
          <thead>
            <tr>
              <th>Metric</th>
              <th>Source</th>
              <th>How to read</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Capacity</strong>
              </td>
              <td>Capacity per Member in the Iteration.</td>
              <td>Planned available hours.</td>
            </tr>
            <tr>
              <td>
                <strong>Estimate</strong>
              </td>
              <td>Total Task Estimate.</td>
              <td>Initial estimate of Tasks in scope.</td>
            </tr>
            <tr>
              <td>
                <strong>ToDo</strong>
              </td>
              <td>Total current Task ToDo.</td>
              <td>Remaining work, updated by users.</td>
            </tr>
            <tr>
              <td>
                <strong>Actual</strong>
              </td>
              <td>Total current Task Actual.</td>
              <td>Actual hours recorded; may be larger than Estimate.</td>
            </tr>
          </tbody>
        </DocTable>
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Select Iteration</strong>
              <p>Changing the Iteration recalculates the four totals and all Team/Member rows.</p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Read by Team scope</strong>
              <p>
                Select a Team to view that Team separately. All Teams shows each Team as a group
                whose Members can be expanded.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Compare the four hour values</strong>
              <p>
                Read values as independent data. ToDo does not equal Estimate minus Actual, and
                Actual is not limited by Estimate.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Check special Members</strong>
              <p>
                Members with Capacity but no Tasks are still displayed. Tasks that do not have an
                Owner are under Unassigned with Capacity 0h.
              </p>
            </div>
          </li>
        </InstructionList>
        <p>
          <strong>Do not adjust Capacity in Reports.</strong> To change Capacity, go back to Track →
          Team Status. The report does not create a separate Capacity store.
        </p>
      </Section>
      <Section
        id="hieu-pham-vi-du-lieu"
        number="10.5"
        title="Understand the scope and timing of data"
        lead="The same update operation can affect three reports differently."
      >
        <DocTable>
          <thead>
            <tr>
              <th>Report</th>
              <th>Data type</th>
              <th>When source data changes</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Iteration Burndown</strong>
              </td>
              <td>Frozen start baseline and daily snapshots.</td>
              <td>Only today's or future snapshots change; locked history stays unchanged.</td>
            </tr>
            <tr>
              <td>
                <strong>Velocity</strong>
              </td>
              <td>
                Reclassified from the current assignment, state, acceptedDate and Plan Estimate.
              </td>
              <td>The chart of the old Iteration may change.</td>
            </tr>
            <tr>
              <td>
                <strong>Team Capacity</strong>
              </td>
              <td>Live projection from Capacity and current Task hours.</td>
              <td>Re-renders immediately with the new data in scope.</td>
            </tr>
          </tbody>
        </DocTable>
        <p>
          Selected Team only retrieves that Team's data. <strong>All Teams</strong> summarizes the
          Teams in the Project and must eliminate duplicates according to stable IDs. Do not
          manually add All Teams figures to individual Team figures.
        </p>
        <p>
          Dates use the Workspace timezone. When comparing Accepted During/After or end-of-day
          snapshots, check the Iteration date and timezone before concluding.
        </p>
      </Section>
      <Section
        id="kiem-tra-du-lieu-thieu"
        number="10.6"
        title="Distinguish zero from missing data"
        lead="Do not use an empty status as evidence that the Team is not working."
      >
        <DocTable>
          <thead>
            <tr>
              <th>Notice or indication</th>
              <th>Meaning</th>
              <th>What to check</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>No daily history</strong>
              </td>
              <td>Burndown does not have a snapshot at the end of the day.</td>
              <td>Check the snapshot job, start date, and Iteration history.</td>
            </tr>
            <tr>
              <td>
                <strong>No start baseline</strong>
              </td>
              <td>The total Task Estimate was not recorded when the Iteration started.</td>
              <td>Do not use or draw Ideal yourself.</td>
            </tr>
            <tr>
              <td>
                <strong>No completed Iteration with work</strong>
              </td>
              <td>Velocity does not have a qualified Iteration in scope yet.</td>
              <td>End date and assigned US/DE.</td>
            </tr>
            <tr>
              <td>
                <strong>No planned capacity and no scoped task hours</strong>
              </td>
              <td>Team Capacity has neither Capacity nor Task hours.</td>
              <td>Iteration, Team, Capacity record and Task assignment.</td>
            </tr>
            <tr>
              <td>
                <strong>0h or 0 Points</strong>
              </td>
              <td>There is valid data and the measured value is 0.</td>
              <td>Read it in the same scope, source and point in time.</td>
            </tr>
          </tbody>
        </DocTable>
        <p>
          Do not interpolate missing history, do not replace null with 0, and do not construct
          graphs from fixture/mockup for operational reporting.
        </p>
      </Section>
      <Section
        id="xu-ly-bao-cao"
        number="10.7"
        title="Troubleshooting"
        lead="Check permissions, scope, timing, and data quality in order."
      >
        <TroubleshootList>
          <article>
            <span>01</span>
            <div>
              <strong>Can't see the Reports menu</strong>
              <p>
                Confirm the account is Workspace Admin or Admin of the selected Project. Editor does
                not have Reports permission.
              </p>
            </div>
          </article>
          <article>
            <span>02</span>
            <div>
              <strong>Can't find the Iteration to select</strong>
              <p>
                Check Project, Team and date range. Burndown/Capacity uses an Iteration; Velocity
                only takes Iterations that have ended and contain US/DE.
              </p>
            </div>
          </article>
          <article>
            <span>03</span>
            <div>
              <strong>Burndown is empty</strong>
              <p>
                Read daily history and start baseline notifications. Do not use the current Task
                value to manually reconstruct the history.
              </p>
            </div>
          </article>
          <article>
            <span>04</span>
            <div>
              <strong>Velocity changed for an old Iteration</strong>
              <p>
                Check whether a US/DE recently changed Iteration, Plan Estimate, state or
                acceptedDate. This report is recalculated from the current assignment.
              </p>
            </div>
          </article>
          <article>
            <span>05</span>
            <div>
              <strong>Capacity is different from Team Status</strong>
              <p>
                Compare within the same Project, Team and Iteration; check Member, Task Owner and
                data loading time.
              </p>
            </div>
          </article>
          <article>
            <span>06</span>
            <div>
              <strong>Actual is larger than Estimate</strong>
              <p>
                This may be valid data. Actual is not capped and ToDo is not inferred from Estimate
                − Actual.
              </p>
            </div>
          </article>
          <article>
            <span>07</span>
            <div>
              <strong>All Teams figures are unusually large</strong>
              <p>
                Check for items or Tasks with duplicate IDs across multiple Teams. Do not add the
                individual Team figures on top of the All Teams total.
              </p>
            </div>
          </article>
        </TroubleshootList>
        <p>
          Export, saved report configurations, and custom date ranges are not currently covered by
          this guide.
        </p>
      </Section>
      <CheckUnderstanding>
        <strong>Check yourself before moving on to the next chapter</strong>
        <ul>
          <li>Do you know that Burndown uses Hours and Points on two axes?</li>
          <li>Do you know which part of Velocity is used for Trend?</li>
          <li>Do you know that Team Capacity is a read-only report on Team Status data?</li>
          <li>Can you tell a zero value from a no-data state?</li>
        </ul>
      </CheckUnderstanding>
    </>
  )
}
