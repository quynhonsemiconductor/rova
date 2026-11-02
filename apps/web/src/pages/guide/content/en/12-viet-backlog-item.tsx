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
          <h2>Write clearly enough for shared understanding, estimation, and testing</h2>
          <Lead>
            A good backlog item describes <strong>problem or value to be achieved</strong>, the
            conditions that must hold, and the boundaries of the work. This section covers the two
            most frequently used types on Rova: <strong>User Story</strong> and{' '}
            <strong>Defect</strong>.
          </Lead>
        </div>
        <ChapterSummary aria-label="After this chapter you will be able to">
          <strong>After this chapter, you will be able to</strong>
          <ul>
            <li>Write a User Story with a clear persona, goal and value.</li>
            <li>Write Acceptance Criteria using Given–When–Then.</li>
            <li>Record Defects that can be reproduced and verified.</li>
            <li>Distinguish a Defect from a change request.</li>
            <li>Self-check items before refinement.</li>
          </ul>
        </ChapterSummary>
      </ChapterIntro>
      <Section
        id="viet-user-story"
        number="12.1"
        title="Write User Story"
        lead="A User Story describes a small piece of value that a user or stakeholder needs to receive."
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
            <TemplateLabel>Business Rules</TemplateLabel>[confirmed permissions, scope and limits]
          </p>
          <p>
            <TemplateLabel>Acceptance Criteria</TemplateLabel>Given [context] · When [action] · Then
            [observable result]
          </p>
          <p>
            <TemplateLabel>Non-scope</TemplateLabel>[content easily assumed to be included but not
            part of the Story]
          </p>
          <p>
            <TemplateLabel>Open questions</TemplateLabel>[missing information that needs PO/BA
            confirmation]
          </p>
        </WritingTemplate>
        <DocTable>
          <thead>
            <tr>
              <th>Element</th>
              <th>How to write</th>
              <th>Avoid</th>
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
              <td>Using “user” for every case without identifying the role.</td>
            </tr>
            <tr>
              <td>
                <strong>Goal</strong>
              </td>
              <td>Describe an action or outcome, small enough to complete in one Iteration.</td>
              <td>Listing screens, APIs or implementation details instead of the need.</td>
            </tr>
            <tr>
              <td>
                <strong>Value</strong>
              </td>
              <td>State clearly which decision, time or risk is improved.</td>
              <td>Repeating the I want to part verbatim.</td>
            </tr>
            <tr>
              <td>
                <strong>Business Rules</strong>
              </td>
              <td>
                Record permissions, scope, status and conditions backed by a confirmed source.
              </td>
              <td>Adding rules, SLAs or notifications of your own that have not been agreed.</td>
            </tr>
            <tr>
              <td>
                <strong>Acceptance Criteria</strong>
              </td>
              <td>Each AC describes a situation and observable outcome.</td>
              <td>Writing it as a detailed Test Case or describing the implementation.</td>
            </tr>
          </tbody>
        </DocTable>
        <p>
          <strong>Acceptance Criteria do not replace Test Cases.</strong> AC determines the
          acceptance conditions of the Story; QA can develop additional test data, variations, and
          technical checks.
        </p>
        <p>
          The example below is used to illustrate how to fill out the template. Business Rules and
          AC must be confirmed by PO/BA before creating the actual Story.
        </p>
        <WritingTemplate aria-label="User Story example on Rova">
          <strong>Illustrative example: Filter Backlog by Priority</strong>
          <p>
            <TemplateLabel>As a</TemplateLabel>Editor on Team Maintainer
          </p>
          <p>
            <TemplateLabel>I want to</TemplateLabel>filter the Backlog by one or more Priorities
          </p>
          <p>
            <TemplateLabel>So that</TemplateLabel>I can focus on handling important Work Items
            within the assigned scope
          </p>
          <p>
            <TemplateLabel>Rule 1</TemplateLabel>Results only include Work Items belonging to
            Projects and Teams the user is allowed to view.
          </p>
          <p>
            <TemplateLabel>Rule 2</TemplateLabel>Clearing all Priority options will return the list
            to its state with no Priority filter.
          </p>
          <p>
            <TemplateLabel>AC 1</TemplateLabel>
            <strong>Given</strong> Backlog has Work Items in many Priorities, <strong>When</strong>{' '}
            the user selects High, <strong>Then</strong> the list shows only Work Items with
            Priority High in the current scope.
          </p>
          <p>
            <TemplateLabel>AC 2</TemplateLabel>
            <strong>Given</strong> the High filter is applied, <strong>When</strong> the user
            deselects High, <strong>Then</strong> Backlog displays all Priorities in the current
            scope again.
          </p>
          <p>
            <TemplateLabel>Non-scope</TemplateLabel>Saving filters as personal views and sharing
            filters.
          </p>
        </WritingTemplate>
        <p>
          <strong>Check against INVEST before refinement:</strong>
        </p>
        <TroubleshootList>
          <article>
            <span>I</span>
            <div>
              <strong>Independent</strong>
              <p>
                Can be implemented and accepted without depending tightly on several undefined
                Stories.
              </p>
            </div>
          </article>
          <article>
            <span>N</span>
            <div>
              <strong>Negotiable</strong>
              <p>
                State the needs and boundaries, while still letting the Team discuss the solution.
              </p>
            </div>
          </article>
          <article>
            <span>V</span>
            <div>
              <strong>Valuable</strong>
              <p>The persona gains clear value when the Story is completed.</p>
            </div>
          </article>
          <article>
            <span>E</span>
            <div>
              <strong>Estimable</strong>
              <p>The Team understands the scope, rules and dependencies well enough to estimate.</p>
            </div>
          </article>
          <article>
            <span>S</span>
            <div>
              <strong>Small</strong>
              <p>Small enough to complete in one Iteration; otherwise, split by flow or rule.</p>
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
        lead="A Defect records the difference between the actual behavior and the expected result."
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
            <TemplateLabel>Context</TemplateLabel>Project, Team, screen, version or environment
            where the error occurred
          </p>
          <p>
            <TemplateLabel>Precondition</TemplateLabel>Data, permissions and status required before
            reproducing
          </p>
          <p>
            <TemplateLabel>Steps</TemplateLabel>Short actions, in the exact order, without combining
            multiple actions
          </p>
          <p>
            <TemplateLabel>Actual</TemplateLabel>Actual results observed
          </p>
          <p>
            <TemplateLabel>Expected</TemplateLabel>The correct result according to the confirmed
            rule or AC
          </p>
          <p>
            <TemplateLabel>Severity</TemplateLabel>Technical or business impact level
          </p>
          <p>
            <TemplateLabel>Priority</TemplateLabel>Order of handling based on the product decision
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
              <th>Inadequate example</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Title</strong>
              </td>
              <td>States the function, the wrong behavior and the main condition.</td>
              <td>“Filter error”, “Not running”, “Bug Backlog”.</td>
            </tr>
            <tr>
              <td>
                <strong>Steps</strong>
              </td>
              <td>Someone else can repeat it with the same data and permissions.</td>
              <td>“Go to Backlog and try filtering”.</td>
            </tr>
            <tr>
              <td>
                <strong>Actual</strong>
              </td>
              <td>Describes exactly what is seen, including values or messages if any.</td>
              <td>“Incorrect result”.</td>
            </tr>
            <tr>
              <td>
                <strong>Expected</strong>
              </td>
              <td>Tied to a confirmed rule or AC.</td>
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
          The Defect below illustrates how to record one. Only create the real item after
          reproducing it and having a source that confirms Expected.
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
            <TemplateLabel>Step 1</TemplateLabel>Open the Backlog and confirm the Project and Team
            are correct.
          </p>
          <p>
            <TemplateLabel>Step 2</TemplateLabel>Open Filters and select Priority = High.
          </p>
          <p>
            <TemplateLabel>Actual</TemplateLabel>The list still shows Work Items with Priority
            Medium.
          </p>
          <p>
            <TemplateLabel>Expected</TemplateLabel>The list only displays Work Items that have
            Priority High in the current scope.
          </p>
          <p>
            <TemplateLabel>Evidence</TemplateLabel>Full-screen screenshot showing the context
            selector, High filter and the Medium row; include the time and Work Item ID.
          </p>
          <p>
            <TemplateLabel>Links</TemplateLabel>User Story “Filter Backlog by Priority”, AC 1.
          </p>
        </WritingTemplate>
        <p>
          <strong>Severity and Priority are not the same.</strong> Severity describes the impact
          level; Priority is the decision on whether to handle it sooner or later. A minor interface
          bug can still have high Priority if it is on an important demo flow.
        </p>
        <TroubleshootList>
          <article>
            <span>01</span>
            <div>
              <strong>Unable to reproduce</strong>
              <p>
                Add the permissions, Project, Team, sample data, browser, time and frequency of
                occurrence.
              </p>
            </div>
          </article>
          <article>
            <span>02</span>
            <div>
              <strong>Expected has no source yet</strong>
              <p>
                Link the requirement or AC. If there is no agreement on the correct behavior, ask
                the PO/BA before concluding that it is a Defect.
              </p>
            </div>
          </article>
          <article>
            <span>03</span>
            <div>
              <strong>One Defect contains several bugs</strong>
              <p>Split by cause or by result that can be fixed and verified independently.</p>
            </div>
          </article>
          <article>
            <span>04</span>
            <div>
              <strong>Screenshot only</strong>
              <p>A screenshot is evidence; it does not replace Steps, Actual and Expected.</p>
            </div>
          </article>
        </TroubleshootList>
      </Section>
      <CheckUnderstanding>
        <strong>Check yourself before putting items into refinement</strong>
        <ul>
          <li>Does the User Story clearly state persona, goal and value?</li>
          <li>Does each Acceptance Criteria have an observable result?</li>
          <li>Does the Defect have enough Context, Steps, Actual and Expected?</li>
          <li>Does Expected have a source, or is this actually a new request?</li>
        </ul>
      </CheckUnderstanding>
    </>
  )
}
