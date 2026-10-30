/*
 * English edition, chapter 03-backlog-cong-viec (US-119). Converted from the BA's static page
 * `public/guide/en/03-backlog-cong-viec.html`.
 */
import { GuideShot } from '../../ui/guide-shot'
import {
  ActionGrid,
  Callout,
  ChapterEyebrow,
  ChapterIntro,
  ChapterSummary,
  CheckUnderstanding,
  DefectRoutes,
  DefinitionGrid,
  DetailGuide,
  DocTable,
  InstructionList,
  Lead,
  ResultBox,
  RouteCard,
  Section,
  TroubleshootList,
} from '../../ui/parts'

export default function Chapter() {
  return (
    <>
      <ChapterIntro id="chapter-03">
        <div>
          <ChapterEyebrow>PART 03 · BACKLOG & WORK</ChapterEyebrow>
          <h2>Create the right Work Item type in the right scope</h2>
          <Lead>
            Backlog is a place to find and manage <strong>User Story</strong> or{' '}
            <strong>Defect</strong> has not been included in Iteration. Please check Project, Team
            and Owner before saving.
          </Lead>
        </div>
        <ChapterSummary aria-label="After this part you will be able to do it">
          <strong>After this chapter, you will be able to</strong>
          <ul>
            <li>Find, filter, and read the Backlog list.</li>
            <li>Create User Story or record Defect.</li>
            <li>Select the correct Team and Owner.</li>
            <li>Opens the details page for additional information and links.</li>
            <li>Handle when you don't see the Work Item or Owner you want to select.</li>
          </ul>
        </ChapterSummary>
      </ChapterIntro>
      <Section
        id="doc-backlog"
        number="03.1"
        title="Read and search in Backlog"
        lead="Backlog only shows User Story and Defect. Tasks are managed in the parent US or DE details page."
      >
        <GuideShot
          name="03-backlog-production"
          alt="Rova Backlog with Search box, Add New button, Filters, Show Fields and Work Items panel."
          caption="Backlog screen and tools to find, filter, and create Work Items."
        />
        <ActionGrid>
          <article>
            <span>1</span>
            <div>
              <strong>Search</strong>
              <p>
                Enter ID as <b>US-52</b>, <b>DE-12</b> or part of the title to narrow the list.
              </p>
            </div>
          </article>
          <article>
            <span>2</span>
            <div>
              <strong>Filters</strong>
              <p>
                Filter by Type, Schedule State, Priority, Owner or Release. Remove the filter when
                you need to review the whole thing.
              </p>
            </div>
          </article>
          <article>
            <span>3</span>
            <div>
              <strong>Show Fields</strong>
              <p>
                Select the columns to read. Commonly used columns include status, Priority,
                Estimate, Owner, Release and Iteration.
              </p>
            </div>
          </article>
          <article>
            <span>4</span>
            <div>
              <strong>Open Work Item</strong>
              <p>
                Select ID in the table to open the details page. Use Rows per page or page
                transition buttons when the list is long.
              </p>
            </div>
          </article>
        </ActionGrid>
        <Callout>
          <strong>Not seeing a Work Item does not mean it is lost</strong>
          <p>
            Check the Project/Team, keywords, filters and current page again. When US/DE is assigned
            to an Iteration, look in the corresponding Iteration instead of the Backlog's
            Unscheduled list.
          </p>
        </Callout>
      </Section>
      <Section
        id="tao-user-story"
        number="03.2"
        title="Create User Story"
        lead="Use User Story for a need or value that needs to be brought to users."
      >
        <GuideShot
          name="03-create-work-item-production"
          alt="Form New Work Item with Story or Defect selection and Title, Project, Team, Owner, Plan Estimate fields."
          caption="Form New Work Item and fields to fill in."
        />
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Open Plan → Backlog</strong>
              <p>Confirm the correct Project and Team on the context selector before continuing.</p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Select Add New</strong>
              <p>
                Form <b>New Work Item</b> opens with the default type being <b>Story</b>.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Enter initial information</strong>
              <p>
                Enter <b>Title</b>; check Project; Select Team, Owner and Plan Estimate once
                determined.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Select how to save</strong>
              <p>
                <b>Create Item</b> creates quickly and returns to Backlog.{' '}
                <b>Create with details</b> created and then opened the details page to continue
                entering.
              </p>
            </div>
          </li>
        </InstructionList>
        <DocTable columns="fields">
          <thead>
            <tr>
              <th>Field</th>
              <th>Required</th>
              <th>How to enter</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Type</strong>
              </td>
              <td>Yes</td>
              <td>
                Hold <b>Story</b> when creating a User Story.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Title</strong>
              </td>
              <td>Yes</td>
              <td>Write briefly, clearly describing the need or result to be achieved.</td>
            </tr>
            <tr>
              <td>
                <strong>Project</strong>
              </td>
              <td>Yes</td>
              <td>
                Rova retrieves the currently selected Project; return to context selector if Project
                is incorrect.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Team</strong>
              </td>
              <td>No</td>
              <td>
                Select Implementation Team. To <b>No team</b> if the new Work Item belongs in the
                Project Backlog.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Owner</strong>
              </td>
              <td>No</td>
              <td>
                Rova populates the currently logged in person when they are eligible. You can choose
                another valid person or <b>— No Entry —</b>.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Plan Estimate</strong>
              </td>
              <td>No</td>
              <td>
                Enter a non-negative number; You can leave it as 0 if you haven't estimated it yet.
              </td>
            </tr>
          </tbody>
        </DocTable>
        <ResultBox>
          <span>EXPECTED RESULTS</span>{' '}
          <strong>User Story is created with new ID and Idea status</strong>
          <p>
            Item appears in the Backlog of the appropriate Project/Team if it has not been assigned
            an Iteration and is not covered by the current filter.
          </p>
        </ResultBox>
      </Section>
      <Section
        id="tao-defect"
        number="03.3"
        title="Record Defect"
        lead="Use Defect when the actual behavior differs from the expected result and needs to be monitored and resolved."
      >
        <DefectRoutes>
          <RouteCard>
            <span>METHOD 1 · QUICK RECORDING</span>
            <h3>Plan → Backlog → Add New</h3>
            <p>
              Select type <b>Defect</b>, enter Title, check Project then select Team, Owner,
              Estimate and Parent Story if known.
            </p>
            <strong>Use when:</strong>
            <p>You are working in the Backlog and need to quickly log errors.</p>
          </RouteCard>
          <RouteCard quality>
            <span>METHOD 2 · RECORD QUALITY</span>
            <h3>Quality → Defects → Add New</h3>
            <p>
              Enter Title, Description, Severity, Priority, Found In and Root Cause; then select
              Assignee, Release and User Story as appropriate.
            </p>
            <strong>Use when:</strong>
            <p>You need to describe and classify the error from the beginning.</p>
          </RouteCard>
        </DefectRoutes>
        <GuideShot
          name="03-quality-defects-production"
          alt="Add New Defect form in Quality with Title, Description, Severity, Priority, Found In, Root Cause, Assignee, Release and User Story fields."
          caption="Form Quality → Defects → Add New and error description fields."
        />
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Open Quality → Defects</strong>
              <p>
                Confirm the correct Project and Team on the context selector, then select{' '}
                <b>Add New</b>.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Error description</strong>
              <p>
                Title clearly states the expression; Description records the reproduction step,
                expected results and actual results.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Classification</strong>
              <p>
                Select Severity, Priority, Found In and Root Cause according to the available
                information. Can be added later if not determined.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Link and save</strong>
              <p>
                Select Assignee, Release and User Story as appropriate. User Story is an optional
                parent link within the same Project.
              </p>
            </div>
          </li>
        </InstructionList>
        <ResultBox>
          <span>EXPECTED RESULTS</span> <strong>Two lines create a shared Defect</strong>
          <p>
            Defect can be opened from Backlog or Quality according to the current scope and filter.
            This is the same record, no need to recreate it on the other screen.
          </p>
        </ResultBox>
        <Callout tone="warning">
          <strong>Don't use Defect instead of Task</strong>
          <p>
            Defect recorded an error that needs tracking. Tasks are implementation specific and are
            only created in tabs <b>Tasks</b> of a US or DE parent.
          </p>
        </Callout>
      </Section>
      <Section
        id="chon-team-owner"
        number="03.4"
        title="Select the correct Team and Owner"
        lead="The right to create a Work Item and the condition to appear in the Owner list are two different things."
      >
        <DocTable>
          <thead>
            <tr>
              <th>User</th>
              <th>When appears in Owner</th>
              <th>How to handle</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Project Admin</strong>
              </td>
              <td>Can be selected within Project.</td>
              <td>
                Select the correct Project; Team does not limit Admin's Project management rights.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Editor</strong>
              </td>
              <td>Only in the currently selected Team are they assigned.</td>
              <td>Select Team first, then reopen the Owner list.</td>
            </tr>
            <tr>
              <td>
                <strong>Workspace Admin</strong>
              </td>
              <td>Only if valid member of the selected Team.</td>
              <td>
                They can still create US/DE with Workspace permission even though the name is not in
                Owner.
              </td>
            </tr>
            <tr>
              <td>
                <strong>— No Entry —</strong>
              </td>
              <td>Always selectable.</td>
              <td>Used when the person responsible has not been identified; reassign later.</td>
            </tr>
          </tbody>
        </DocTable>
        <DefinitionGrid>
          <article>
            <strong>No team</strong>
            <p>
              Item is located in the Project Backlog. Editor or Workspace Admin is a Team member
              that is usually not included in Owner without selecting a Team.
            </p>
          </article>
          <article>
            <strong>All Teams</strong>
            <p>This is an Admin view scope, not a Team to assign to Work Item.</p>
          </article>
          <article>
            <strong>Owner and Dev Owner</strong>
            <p>
              Two independent schools but using the same pool of qualified people. You can leave it
              blank and choose two different people.
            </p>
          </article>
        </DefinitionGrid>
      </Section>
      <Section
        id="cap-nhat-work-item"
        number="03.5"
        title="Update and link Work Item"
        lead="Open ID from Backlog to add information that is not in the quick create form."
      >
        <DetailGuide>
          <article>
            <span>01</span>
            <h3>Open the details page</h3>
            <p>
              Select the ID of US or DE. Tabs in use include: <b>Details</b>, <b>Tasks</b>,{' '}
              <b>Connections</b> and <b>Revision History</b>.
            </p>
          </article>
          <article>
            <span>02</span>
            <h3>Added content</h3>
            <p>
              Update Title, Description, Notes, Release Notes, Comments, Attachments or Linked Items
              as needed.
            </p>
          </article>
          <article>
            <span>03</span>
            <h3>Assign plans and responsibilities</h3>
            <p>
              Select Schedule State, Flow State, Owner, Dev Owner, Team, Estimate, Iteration,
              Release and Milestones. Defect has additional Priority.
            </p>
          </article>
          <article>
            <span>05</span>
            <h3>Link level is correct</h3>
            <p>
              US/DE can link Feature. Defect can choose to add Parent Story. Tasks are created in
              the Tasks tab of the parent US or DE.
            </p>
          </article>
        </DetailGuide>
        <Callout tone="warning">
          <strong>Check Owner again after changing Team</strong>
          <p>
            The old Owner or Dev Owner may no longer be valid in the new Team. Choose the right
            person again or leave <b>— No Entry —</b> before continuing.
          </p>
        </Callout>
      </Section>
      <Section
        id="xu-ly-backlog"
        number="03.6"
        title="Troubleshooting"
        lead="Check the order below before recreating or asking someone else to intervene."
      >
        <TroubleshootList>
          <article>
            <span>01</span>
            <div>
              <strong>US/DE not found</strong>
              <p>
                Check the context selector, clear Search and Filters, see the next page, then check
                if the item has entered Iteration.
              </p>
            </div>
          </article>
          <article>
            <span>02</span>
            <div>
              <strong>Can't find the person to select</strong>
              <p>
                Choose the correct Team and check membership. If not qualified, keep{' '}
                <b>— No Entry —</b> and ask Workspace Admin to update Team.
              </p>
            </div>
          </article>
          <article>
            <span>03</span>
            <div>
              <strong>Create button is not enabled</strong>
              <p>
                Make sure you have selected Story or Defect, entered Title and are in Project, you
                have permission to create Work Item.
              </p>
            </div>
          </article>
          <article>
            <span>05</span>
            <div>
              <strong>The newly created item is no longer in the list</strong>
              <p>
                Clear filter, check Project/Team and Iteration. Items that have entered Iteration
                will no longer be in the Unscheduled Backlog list.
              </p>
            </div>
          </article>
        </TroubleshootList>
        <CheckUnderstanding>
          <strong>Check yourself before moving on to the next section</strong>
          <ul>
            <li>Have you selected the correct Project and Team?</li>
            <li>Are you creating a User Story or a Defect?</li>
            <li>Is the Owner eligible to be in the currently selected Team?</li>
            <li>Do you know when to open the details page?</li>
          </ul>
        </CheckUnderstanding>
      </Section>
    </>
  )
}
