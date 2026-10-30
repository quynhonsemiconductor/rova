/*
 * English edition, chapter 12-viet-backlog-item (US-119). Converted from the BA's static page
 * `public/guide/en/12-viet-backlog-item.html`.
 */
import {
  ChapterEyebrow,
  ChapterIntro,
  ChapterSummary,
  CheckUnderstanding,
  DocTable,
  Lead,
  Section,
  TemplateLabel,
  TroubleshootList,
  WritingTemplate,
} from '../../ui/parts'

export default function Chapter() {
  return (
    <>
      <ChapterIntro id="chapter-12">
        <div>
          <ChapterEyebrow>PART 12 · AGILE GUIDELINE</ChapterEyebrow>
          <h2>Write clearly enough for mutual understanding, evaluation, and testing</h2>
          <Lead>
            A well-described backlog item <strong>problem or value to be achieved</strong>, the
            conditions must be true and the scope boundary. This section guides two frequently used
            types on Rova: <strong>User Story</strong> and <strong>Defect</strong>.
          </Lead>
        </div>
        <ChapterSummary aria-label="After this part you will be able to do it">
          <strong>After this chapter, you will be able to</strong>
          <ul>
            <li>Write a User Story with clear personas, goals, and values.</li>
            <li>Write Acceptance Criteria using Given–When–Then.</li>
            <li>Defect record is reproducible and verifiable.</li>
            <li>Distinguish Defect from change request.</li>
            <li>Self-check items before refining.</li>
          </ul>
        </ChapterSummary>
      </ChapterIntro>
      <Section
        id="viet-user-story"
        number="12.1"
        title="Write User Story"
        lead="User Story describes a small value that a user or stakeholder needs to receive."
      >
        <p>
          Use User Stories when the work creates a behavior or result that can be delivered and
          tested independently. The title should start with a verb and clearly state the result, for
          example <strong>“Filter Backlog by Priority”</strong>. Avoid generic titles like “Improve
          Backlog” or “Make a filter screen”.
        </p>
        <WritingTemplate aria-label="Template User Story">
          <strong>Template User Story</strong>
          <p>
            <TemplateLabel>Title</TemplateLabel>[Verb + object + desired result]
          </p>
          <p>
            <TemplateLabel>As a</TemplateLabel>[specific persona or role]
          </p>
          <p>
            <TemplateLabel>I want to</TemplateLabel>[action or outcome to be performed]
          </p>
          <p>
            <TemplateLabel>So that</TemplateLabel>[value received or problem resolved]
          </p>
          <p>
            <TemplateLabel>Business Rules</TemplateLabel>[permissions, scope and limits confirmed]
          </p>
          <p>
            <TemplateLabel>Acceptance Criteria</TemplateLabel>Given [context] · When [action] · Then
            [observable result]
          </p>
          <p>
            <TemplateLabel>Non-scope</TemplateLabel>[content easily misunderstood but not part of
            Story]
          </p>
          <p>
            <TemplateLabel>Open questions</TemplateLabel>[missing information needs PO/BA
            confirmation]
          </p>
        </WritingTemplate>
        <DocTable>
          <thead>
            <tr>
              <th>Ingredients</th>
              <th>How to write</th>
              <th>Should be avoided</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Persona</strong>
              </td>
              <td>
                Select the person who directly receives the value or is responsible for the result.
              </td>
              <td>Use “user” in all cases without defining roles.</td>
            </tr>
            <tr>
              <td>
                <strong>Goal</strong>
              </td>
              <td>Describes an action or outcome, small enough to be completed in an Iteration.</td>
              <td>List screens, APIs or code instead of needs.</td>
            </tr>
            <tr>
              <td>
                <strong>Value</strong>
              </td>
              <td>Articulate improved decision, time, or risk.</td>
              <td>Repeat verbatim part I want to.</td>
            </tr>
            <tr>
              <td>
                <strong>Business Rules</strong>
              </td>
              <td>
                Record permissions, scope, status and conditions that have been confirmed by the
                source.
              </td>
              <td>Manually adding a rule, SLA or notification has not been agreed upon.</td>
            </tr>
            <tr>
              <td>
                <strong>Acceptance Criteria</strong>
              </td>
              <td>Each AC describes a situation and observable outcome.</td>
              <td>Write as a detailed Test Case or describe how to deploy.</td>
            </tr>
          </tbody>
        </DocTable>
        <p>
          <strong>Acceptance Criteria does not replace Test Case.</strong> AC determines the
          acceptance conditions of Story; QA can develop additional test data, variations, and
          technical inspections.
        </p>
        <p>
          The example below is used to illustrate how to fill out the template. Business Rules and
          AC must be confirmed by PO/BA before creating the actual Story.
        </p>
        <WritingTemplate aria-label="User Story example on Rova">
          <strong>Illustrative example: Filter Backlog by Priority</strong>
          <p>
            <TemplateLabel>As a</TemplateLabel>Editor of Team Maintainer
          </p>
          <p>
            <TemplateLabel>I want to</TemplateLabel>filters Backlog according to one or more
            Priorities
          </p>
          <p>
            <TemplateLabel>So that</TemplateLabel>I can focus on handling important Work Items
            within the assigned scope
          </p>
          <p>
            <TemplateLabel>Rule 1</TemplateLabel>Results only include Work Items belonging to
            Projects and Teams that users are allowed to view.
          </p>
          <p>
            <TemplateLabel>Rule 2</TemplateLabel>Clearing all Priority options will return the list
            to an unfiltered state by Priority.
          </p>
          <p>
            <TemplateLabel>AC 1</TemplateLabel>
            <strong>Given</strong> Backlog has Work Items in many Priorities, <strong>When</strong>{' '}
            the user selects High, <strong>Then</strong> list only shows Work Items with Priority
            High in the current scope.
          </p>
          <p>
            <TemplateLabel>AC 2</TemplateLabel>
            <strong>Given</strong> High filter is applied, <strong>When</strong> the user deselects
            High, <strong>Then</strong> Backlog displays all Priorities in the current scope again.
          </p>
          <p>
            <TemplateLabel>Non-scope</TemplateLabel>Save filters as personal views and share
            filters.
          </p>
        </WritingTemplate>
        <p>
          <strong>Check according to INVEST before refining:</strong>
        </p>
        <TroubleshootList>
          <article>
            <span>I</span>
            <div>
              <strong>Independent</strong>
              <p>Can be deployed and accepted without strong dependence on many unknown Stories.</p>
            </div>
          </article>
          <article>
            <span>N</span>
            <div>
              <strong>Negotiable</strong>
              <p>State the needs and boundaries, still allowing the Team to exchange solutions.</p>
            </div>
          </article>
          <article>
            <span>V</span>
            <div>
              <strong>Valuable</strong>
              <p>Persona gains explicit value when Story is completed.</p>
            </div>
          </article>
          <article>
            <span>E</span>
            <div>
              <strong>Estimable</strong>
              <p>Team understands enough scope, rules and dependencies to estimate.</p>
            </div>
          </article>
          <article>
            <span>S</span>
            <div>
              <strong>Small</strong>
              <p>Small enough to complete in one Iteration; otherwise, split by stream or rule.</p>
            </div>
          </article>
          <article>
            <span>T</span>
            <div>
              <strong>Testable</strong>
              <p>AC has observable results and is not dependent on subjective feelings.</p>
            </div>
          </article>
        </TroubleshootList>
      </Section>
      <Section
        id="viet-defect"
        number="12.2"
        title="Write Defect"
        lead="Defect records the difference between the actual behavior and the expected result."
      >
        <p>
          Only create a Defect when there is evidence that the system is different from the
          requirement, Acceptance Criteria or approved behavior. If a user wants a capability that
          was never requested, it's usually a User Story or change request.
        </p>
        <WritingTemplate aria-label="Template Defect">
          <strong>Template Defect</strong>
          <p>
            <TemplateLabel>Title</TemplateLabel>[Function] – [wrong behavior] when [condition]
          </p>
          <p>
            <TemplateLabel>Context</TemplateLabel>Project, Team, monitor, version or environment
            error occurred
          </p>
          <p>
            <TemplateLabel>Precondition</TemplateLabel>Data, permissions and status required before
            rendering
          </p>
          <p>
            <TemplateLabel>Steps</TemplateLabel>Actions are short, in the correct order, and do not
            combine multiple actions
          </p>
          <p>
            <TemplateLabel>Actual</TemplateLabel>Actual results observed
          </p>
          <p>
            <TemplateLabel>Expected</TemplateLabel>The result is correct according to the rule or AC
            has been confirmed
          </p>
          <p>
            <TemplateLabel>Severity</TemplateLabel>Technical or business impact level
          </p>
          <p>
            <TemplateLabel>Priority</TemplateLabel>The order to be processed depends on the product
            decision
          </p>
          <p>
            <TemplateLabel>Evidence</TemplateLabel>Photos, videos, logs, timestamps and related data
            IDs
          </p>
          <p>
            <TemplateLabel>Links</TemplateLabel>Related User Story, Feature or Defect
          </p>
        </WritingTemplate>
        <DocTable>
          <thead>
            <tr>
              <th>Field</th>
              <th>Minimum standards</th>
              <th>Failed example</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Title</strong>
              </td>
              <td>Tells the main functions, misbehaviors and conditions.</td>
              <td>“Filter error”, “Not running”, “Bug Backlog”.</td>
            </tr>
            <tr>
              <td>
                <strong>Steps</strong>
              </td>
              <td>Others can iterate on the same data and permissions.</td>
              <td>“Go to Backlog and try filtering”.</td>
            </tr>
            <tr>
              <td>
                <strong>Actual</strong>
              </td>
              <td>Correct description of what is seen, including value or message if any.</td>
              <td>“Incorrect result”.</td>
            </tr>
            <tr>
              <td>
                <strong>Expected</strong>
              </td>
              <td>Bind to confirmed rule or AC.</td>
              <td>Propose a new feature that is not in the requirements.</td>
            </tr>
            <tr>
              <td>
                <strong>Evidence</strong>
              </td>
              <td>Shows the time, scope, and enough data for traceability.</td>
              <td>The image omits the related URL, Project, Team, or status.</td>
            </tr>
          </tbody>
        </DocTable>
        <p>
          Defect below illustrates how to record. Only create real items after recreating and having
          a source confirm Expected.
        </p>
        <WritingTemplate aria-label="Defect example on Rova">
          <strong>Illustrative example: Backlog – High filter still displays Medium item</strong>
          <p>
            <TemplateLabel>Context</TemplateLabel>Rova web · Project ROVA · Team Maintainer ·
            Backlog page
          </p>
          <p>
            <TemplateLabel>Precondition</TemplateLabel>Account has permission to view Team; Backlog
            has at least one High item and one Medium item.
          </p>
          <p>
            <TemplateLabel>Step 1</TemplateLabel>Open Backlog and confirm correct Project and Team.
          </p>
          <p>
            <TemplateLabel>Step 2</TemplateLabel>Open Filters and select Priority = High.
          </p>
          <p>
            <TemplateLabel>Actual</TemplateLabel>The list still shows Work Item with Priority
            Medium.
          </p>
          <p>
            <TemplateLabel>Expected</TemplateLabel>The list only displays Work Items that have
            Priority High in the current scope.
          </p>
          <p>
            <TemplateLabel>Evidence</TemplateLabel>Full screen image with context selector, High
            filter and Medium line; with time and Work Item ID.
          </p>
          <p>
            <TemplateLabel>Links</TemplateLabel>User Story “Filter Backlog by Priority”, AC 1.
          </p>
        </WritingTemplate>
        <p>
          <strong>Severity and Priority are not the same.</strong> Severity describes the impact
          level; Priority is the decision to process sooner or later. A minor interface bug can
          still have high Priority if it is on an important demo stream.
        </p>
        <TroubleshootList>
          <article>
            <span>01</span>
            <div>
              <strong>Unable to reproduce</strong>
              <p>Add permissions, Project, Team, sample data, browser, when and how often.</p>
            </div>
          </article>
          <article>
            <span>02</span>
            <div>
              <strong>Expected has no source yet</strong>
              <p>
                Link requirement or AC. If there is no agreement on the correct behavior, ask the
                PO/BA before concluding that it is Defective.
              </p>
            </div>
          </article>
          <article>
            <span>03</span>
            <div>
              <strong>A Defect contains many errors</strong>
              <p>Separate by cause or effect that can be edited and independently verified.</p>
            </div>
          </article>
          <article>
            <span>05</span>
            <div>
              <strong>Photos only</strong>
              <p>Photos are proof, do not replace Steps, Actual and Expected.</p>
            </div>
          </article>
        </TroubleshootList>
      </Section>
      <CheckUnderstanding>
        <strong>Check yourself before putting items into refinement</strong>
        <ul>
          <li>Does the User Story clearly state persona, goal and value?</li>
          <li>Does each Acceptance Criteria have an observable result?</li>
          <li>Does Defect have enough Context, Steps, Actual and Expected?</li>
          <li>Expected already has a source, or is this essentially a new request?</li>
        </ul>
      </CheckUnderstanding>
    </>
  )
}
