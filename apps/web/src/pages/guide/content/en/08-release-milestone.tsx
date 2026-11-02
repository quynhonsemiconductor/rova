/*
 * English edition, chapter 08-release-milestone (US-119). Converted from the BA's static page
 * `public/guide/en/08-release-milestone.html`.
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
      <ChapterIntro id="chapter-08">
        <div>
          <ChapterEyebrow>PART 08 · RELEASE & MILESTONE</ChapterEyebrow>
          <h2>Manage delivery milestones and read progress in the right place</h2>
          <Lead>
            <strong>Release</strong> identifies a Project delivery window.{' '}
            <strong>Milestone</strong> records milestones and can link multiple Releases. Create and
            edit these two objects at <strong>Plan → Timeboxes</strong>; See Release progress here{' '}
            <strong>Portfolio → Release Tracking</strong>.
          </Lead>
        </div>
        <ChapterSummary aria-label="After this part you will be able to do it">
          <strong>After this chapter, you will be able to</strong>
          <ul>
            <li>Select the correct Release monitoring or management screen.</li>
            <li>Create Release with valid date and status.</li>
            <li>Create Milestones and understand when dates are entered manually.</li>
            <li>Link Work Item, Feature or Epic to the correct Artifacts type.</li>
            <li>Read data groups and Burnup charts in Release Tracking.</li>
          </ul>
        </ChapterSummary>
      </ChapterIntro>
      <Section
        id="chon-dung-man-hinh"
        number="08.1"
        title="Select the correct screen before operating"
        lead="Release information and progress metrics are in two different areas."
      >
        <DocTable>
          <thead>
            <tr>
              <th>When needed</th>
              <th>Open at</th>
              <th>Done here</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Create or edit Release</strong>
              </td>
              <td>Plan → Timeboxes → Releases</td>
              <td>Manage Name, Theme, date, status, metadata, Release Notes and Artifacts.</td>
            </tr>
            <tr>
              <td>
                <strong>Create or edit Milestone</strong>
              </td>
              <td>Plan → Timeboxes → Milestones</td>
              <td>
                Manage milestones, target dates, Owner, Project/Team scope, Release links and
                Artifacts.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Read Release progress</strong>
              </td>
              <td>Portfolio → Release Tracking</td>
              <td>Read Feature/Work Item groups, status by Points or Count and Burnup chart.</td>
            </tr>
          </tbody>
        </DocTable>
        <p>
          <strong>Access rights:</strong> Workspace Admin and Project Admin can manage
          Release/Milestone within the allowed scope. Editor does not use these planning screens.
          Before proceeding, check Project and Team on the top bar.
        </p>
        <p>
          <strong>Do not create Release in Release Tracking.</strong> This is the monitor screen.
          Release Planning and Dependencies analysis are not active functions in this guide.
        </p>
      </Section>
      <Section
        id="tao-release"
        number="08.2"
        title="Create Release"
        lead="Use Release when you need to determine the time period and target for a Project delivery."
      >
        <p>
          <strong>Before you start:</strong> select the correct Project, prepare the Release name,
          start date, expected delivery date and initial status.
        </p>
        <DocTable>
          <thead>
            <tr>
              <th>Field</th>
              <th>What to enter</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Release name</strong>
              </td>
              <td>Short name for the delivery.</td>
              <td>Required and should be distinguishable from other Releases.</td>
            </tr>
            <tr>
              <td>
                <strong>Theme</strong>
              </td>
              <td>Main goal or topic.</td>
              <td>Details can be added later.</td>
            </tr>
            <tr>
              <td>
                <strong>Start Date / Release Date</strong>
              </td>
              <td>Estimated time period.</td>
              <td>Release Date cannot be earlier than Start Date.</td>
            </tr>
            <tr>
              <td>
                <strong>Status</strong>
              </td>
              <td>Planning, Active or Accepted.</td>
              <td>This is the Release state, independent of the US/DE state.</td>
            </tr>
            <tr>
              <td>
                <strong>Description</strong>
              </td>
              <td>Short description or notes.</td>
              <td>Do not use in place of detailed Release Notes.</td>
            </tr>
          </tbody>
        </DocTable>
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Open Plan → Timeboxes</strong>
              <p>
                In the Timebox selector, select <b>Releases</b>. The list only displays Release of
                the current Project.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Select Add New</strong>
              <p>
                The Create Release form opens with the Release name, Theme, Start Date, Release
                Date, Status and Description fields.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Enter name, date and status</strong>
              <p>
                Select Planning while Release is still preparing; Active when the delivery is taking
                place; Accepted when the result has been accepted.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Choose how to complete</strong>
              <p>
                <b>Create Release</b> saves and returns to the list. <b>Create with details</b>{' '}
                opens the Release Detail page to add metadata and detailed content.
              </p>
            </div>
          </li>
          <li>
            <span>5</span>
            <div>
              <strong>Check the newly created Release</strong>
              <p>
                Compare name, Project, date and State on the list or Release Detail before assigning
                Work Item.
              </p>
            </div>
          </li>
        </InstructionList>
        <p>
          In Release Detail, you can add <strong>Release Theme</strong>,{' '}
          <strong>Notes & Scope Deliverables</strong>, <strong>Release Notes</strong>, Planned
          Velocity, Plan Estimate and Version. This page does not show Burnup or Accepted progress;
          Those numbers are in Release Tracking.
        </p>
      </Section>
      <Section
        id="tao-milestone"
        number="08.3"
        title="Create Milestone"
        lead="Use Milestone for a demo, acceptance, or milestone that may span multiple Releases."
      >
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Open Plan → Timeboxes → Milestones</strong>
              <p>The screen displays Name, Target Start Date, Target End Date and Status.</p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Select Add New</strong>
              <p>
                Enter Milestone name; Select Status, Owner and add Description or Notes as needed.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Select Date or Release link</strong>
              <p>
                If Associated Releases is not selected, enter Target Start and Target End. If one or
                more Releases are selected, the target date will be calculated from those Releases.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Select Create Milestone</strong>
              <p>
                After saving, open Milestone Detail to check the date, status, Release link and
                Project/Team scope.
              </p>
            </div>
          </li>
        </InstructionList>
        <p>
          <strong>Milestone status</strong> includes Planned, At Risk, Met, Missed, Cancelled and
          Completed. This is the state of the mold; Do not use in place of Release status or Work
          Item status.
        </p>
        <p>Milestone has no velocity, Task Estimate or Iteration carry-over rules.</p>
      </Section>
      <Section
        id="lien-ket-release-milestone"
        number="08.4"
        title="Understand links and target dates"
        lead="Release and Milestone can be created in any order and are associated many-to-many."
      >
        <DocTable>
          <thead>
            <tr>
              <th>Link status</th>
              <th>How to determine Milestone date</th>
              <th>When changing</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>There is no associated Release</strong>
              </td>
              <td>Target Start and Target End are entered manually.</td>
              <td>Authorized users can edit directly for two days.</td>
            </tr>
            <tr>
              <td>
                <strong>There is a Release</strong>
              </td>
              <td>Get the Start Date and Release Date of that Release.</td>
              <td>Milestone date becomes inferred value.</td>
            </tr>
            <tr>
              <td>
                <strong>There are many Releases</strong>
              </td>
              <td>
                Target Start is the earliest start date; Target End is the latest delivery date.
              </td>
              <td>Changing the Release list will recalculate the date range.</td>
            </tr>
            <tr>
              <td>
                <strong>Uninstall all Release</strong>
              </td>
              <td>Milestone returns to manual date entry mode.</td>
              <td>Check and re-enter the appropriate date before saving.</td>
            </tr>
          </tbody>
        </DocTable>
        <p>
          Release and Milestone are two independent relationships on Work Item. Change the Release
          of a US/DE <strong>does not delete itself</strong> selected Milestones. When a Work Item
          has a Release, the new Milestones to Add list displays only the Milestones associated with
          that Release.
        </p>
      </Section>
      <Section
        id="quan-ly-artifacts"
        number="08.5"
        title="Manage Artifacts of the correct type"
        lead="Artifacts are Work Items or Portfolio Items associated with a Release or Milestone."
      >
        <DocTable>
          <thead>
            <tr>
              <th>Scope</th>
              <th>Artifacts are valid</th>
              <th>Rules to remember</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Release</strong>
              </td>
              <td>User Story, Defect and Feature are assigned directly.</td>
              <td>
                Each US/DE can only have a maximum of one Release. Task and Epic are not Release
                Artifact.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Milestone</strong>
              </td>
              <td>
                Story, Defect, Feature and Epic; may include descendants inherited from
                Feature/Epic.
              </td>
              <td>
                A Work Item can belong to many Milestones if it is still within the valid scope.
              </td>
            </tr>
          </tbody>
        </DocTable>
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Assign Release from Work Item or Feature</strong>
              <p>
                Open the appropriate Backlog, Work Item Detail or Portfolio Item and select Release.
                Selecting another Release will replace the old Release link but will not change the
                Iteration or Milestone.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Check the Release Artifacts tab</strong>
              <p>
                Open Release Detail → Artifacts to find and check the linked items. Add Artifact
                allows choosing an existing Story/Defect; This operation does not create a new Work
                Item.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Assign Milestone using multi-select list</strong>
              <p>
                On the Work Item, select one or more valid Milestones. The selected Milestones must
                remain visible when you reopen the field.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Check Milestone Artifacts</strong>
              <p>
                Compare directly assigned items and items inherited through Feature/Epic. Duplicate
                data must be counted only once.
              </p>
            </div>
          </li>
        </InstructionList>
        <p>
          <strong>Do not use Add Artifact to replace the Work Item creation flow.</strong> When you
          need to create a new US/DE or Feature, create it in Backlog or Portfolio and then assign
          Release/Milestone to the correct field of the object.
        </p>
      </Section>
      <Section
        id="doc-release-tracking"
        number="08.6"
        title="Read Release Tracking"
        lead="Use Portfolio → Release Tracking to view the scope and progress of the currently selected Release."
      >
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Check Project and Team</strong>
              <p>
                Release Tracking uses global scope on the header bar. Switching Team will
                recalculate the list and chart; the page does not have a second Project/Team filter.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Select Release</strong>
              <p>
                Use the previous button, the Release list and the following button at the top of the
                page. The date range next to the name is what the Release window is reading.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Select Chart Unit</strong>
              <p>
                <b>Points</b> plus Plan Estimate of Story/Defect; <b>Count</b> counts Story/Defect.
                This selection applies to both the Status and Burnup columns.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Select the group to view</strong>
              <p>
                <b>Features in Release</b> is a directly assigned Feature; <b>Derived Features</b>{' '}
                is a Feature that appears because there is a child Story/Defect in Release;{' '}
                <b>Unparented Stories & Defects</b> is an item without a parent Feature.
              </p>
            </div>
          </li>
          <li>
            <span>5</span>
            <div>
              <strong>Read Status and Burnup</strong>
              <p>
                Planned takes Story/Defect of Release. Accepted only counts items in Accepted or
                Release status; Completed is not considered Accepted.
              </p>
            </div>
          </li>
        </InstructionList>
        <p>
          Burnup chart displays Accepted, Planned, Preliminary Estimate and target line in the
          Release window. The Iteration line below helps compare the cycles passing through that
          time period.
        </p>
        <p>
          <strong>Historical void is not zero.</strong> Dates without snapshots are displayed as
          blanks. Do not conclude that progress is zero if the history is lacking or incomplete.
        </p>
        <p>
          <strong>Dependencies · Future</strong> is just a label for future functionality; Do not
          use it to assess dependency risk in the current version.
        </p>
      </Section>
      <Section
        id="xu-ly-release-milestone"
        number="08.7"
        title="Troubleshooting"
        lead="Check permissions, scope, and relationships before regenerating data."
      >
        <TroubleshootList>
          <article>
            <span>01</span>
            <div>
              <strong>Release or Milestone not found</strong>
              <p>
                Check the correct Project, uncheck Search/Filters and confirm the account has
                Workspace Admin or Admin rights at that Project.
              </p>
            </div>
          </article>
          <article>
            <span>02</span>
            <div>
              <strong>Cannot create or edit</strong>
              <p>
                Editor does not have permission to manage Timeboxes. Contact Project Admin instead
                of requesting additional Team membership.
              </p>
            </div>
          </article>
          <article>
            <span>03</span>
            <div>
              <strong>Milestone date cannot be adjusted</strong>
              <p>
                Milestone is binding at least one Release so the date is inferred. Check Associated
                Releases before changing associations.
              </p>
            </div>
          </article>
          <article>
            <span>05</span>
            <div>
              <strong>Item not available in Release Artifacts</strong>
              <p>
                Compare Project, item type and Release field. US/DE may be in another Release; Task
                and Epic do not appear in this list.
              </p>
            </div>
          </article>
          <article>
            <span>06</span>
            <div>
              <strong>No Milestone to select on Work Item</strong>
              <p>
                If the item already has a Release, only the Milestone associated with that Release
                is included in the new selection list. Previously selected Milestones do not
                disappear.
              </p>
            </div>
          </article>
          <article>
            <span>07</span>
            <div>
              <strong>Burnup is blank or broken</strong>
              <p>
                Check Release, Team scope, Unit Chart and history quality. Snapshot space is not
                interpreted as zero.
              </p>
            </div>
          </article>
        </TroubleshootList>
      </Section>
      <CheckUnderstanding>
        <strong>Check yourself before moving on to the next section</strong>
        <ul>
          <li>
            Do you know where to create Release is different from where to read Release Tracking?
          </li>
          <li>Do you know when the Milestone date was hand-entered or inferred?</li>
          <li>Have you distinguished Release Artifact from Milestone Artifact?</li>
          <li>Do you know that Completed is not counted as Accepted in Release Tracking?</li>
        </ul>
      </CheckUnderstanding>
    </>
  )
}
