/*
 * English edition, chapter 05-lap-ke-hoach (US-119). Converted from the BA's static page
 * `public/guide/en/05-lap-ke-hoach.html`.
 */
import { GuideShot } from '../../ui/guide-shot'
import {
  ActionGrid,
  Callout,
  ChapterEyebrow,
  ChapterIntro,
  ChapterSummary,
  CheckUnderstanding,
  DocTable,
  InstructionList,
  IterationChangeGrid,
  IterationStateCard,
  IterationStateFlow,
  Lead,
  ResultBox,
  Section,
  TaskPrereq,
  TroubleshootList,
} from '../../ui/parts'

export default function Chapter() {
  return (
    <>
      <ChapterIntro id="chapter-05">
        <div>
          <ChapterEyebrow>PART 05 · PLANNING</ChapterEyebrow>
          <h2>Plan an Iteration with clear scope</h2>
          <Lead>
            <strong>Iteration</strong> is a short cycle for the Team to execute a group of User
            Stories and Defects. Please create the correct Iteration Project, set{' '}
            <strong>Planned Velocity</strong>, then bring each Work Item from status{' '}
            <strong>Unscheduled</strong> into the appropriate cycle.
          </Lead>
        </div>
        <ChapterSummary aria-label="After this part you will be able to do it">
          <strong>After this chapter, you will be able to</strong>
          <ul>
            <li>Read Iteration list and status.</li>
            <li>Create the correct Iteration for Project and Team.</li>
            <li>Set Planned Velocity to the number of Team Points expected to complete.</li>
            <li>Include US/DE in an Iteration.</li>
            <li>Change Iteration or return item to Unscheduled.</li>
            <li>Handle common data and scope errors.</li>
          </ul>
        </ChapterSummary>
      </ChapterIntro>
      <Section
        id="doc-timeboxes"
        number="05.1"
        title="Read the Iteration list"
        lead={
          <>
            Enter <b>Plan → Timeboxes</b> and select <b>Iterations</b> to view the current Project
            cycles.
          </>
        }
      >
        <GuideShot
          name="04-timeboxes-production"
          alt="Iterations list with Timebox selector, summary metrics, Search, Add New, Filters, Show Fields and Iteration table."
          caption="Plan → Timeboxes screen and Iteration list."
        />
        <ActionGrid>
          <article>
            <span>1</span>
            <div>
              <strong>Select Timebox type</strong>
              <p>
                Use the list next to the title to switch between Iterations, Releases and
                Milestones.
              </p>
            </div>
          </article>
          <article>
            <span>2</span>
            <div>
              <strong>Read aggregated data</strong>
              <p>
                Total is the total number; Planning, Committed and Accepted are the Iteration
                numbers for each state.
              </p>
            </div>
          </article>
          <article>
            <span>3</span>
            <div>
              <strong>Search and filter</strong>
              <p>
                Use Search, Filters and Show Fields to narrow the list or select columns to read.
              </p>
            </div>
          </article>
          <article>
            <span>4</span>
            <div>
              <strong>Open Iteration</strong>
              <p>
                Select ID to view details. The main columns include start date, end date, Planned
                Velocity, Task Estimate and State.
              </p>
            </div>
          </article>
        </ActionGrid>
        <Callout>
          <strong>Don't confuse the two types of states</strong>
          <p>
            <b>Iteration State</b> indicates whether the cycle is Planning, Committed or Accepted.
            Schedule State and Flow State show the progress of each internal US/DE.
          </p>
        </Callout>
      </Section>
      <Section
        id="tao-iteration"
        number="05.2"
        title="Create Iteration"
        lead="Workspace Admin or Project Admin creates a cycle for the currently selected Project. Team can be left blank if Iteration is used at the Project level."
      >
        <GuideShot
          name="04-create-iteration-production"
          alt="New Iteration form with Name, Project, Team, Start Date, End Date and State fields."
          caption="New Iteration Form and fields to fill in."
        />
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Check Project</strong>
              <p>
                The project on the form is taken from the current context and cannot be edited
                directly. Change context first if Project is not correct.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Open the creation form</strong>
              <p>
                Enter <b>Plan → Timeboxes</b>, select <b>Iterations</b>, then select <b>Add New</b>.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Enter scope and dates</strong>
              <p>
                Enter Name; select Team if necessary; Select Start Date, End Date and State. The
                start date cannot be after the end date.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Select how to save</strong>
              <p>
                <b>Create Iteration</b> create quickly. <b>Create with details</b> creates and then
                opens the details page to add information.
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
                <strong>Name</strong>
              </td>
              <td>Yes</td>
              <td>Use a short name, easy to identify the cycle or time period.</td>
            </tr>
            <tr>
              <td>
                <strong>Project</strong>
              </td>
              <td>Yes</td>
              <td>
                Rova gets the current Project. If you want to change Project, close the form and
                change context.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Team</strong>
              </td>
              <td>No</td>
              <td>
                Select Team under Project; to <b>No team</b> if Iteration applies at the Project
                level.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Start / End Date</strong>
              </td>
              <td>Yes</td>
              <td>
                Select a valid execution interval; Start Date must be before or equal to End Date.
              </td>
            </tr>
            <tr>
              <td>
                <strong>State</strong>
              </td>
              <td>Yes</td>
              <td>
                New Iteration normally starts at <b>Planning</b>.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Planned Velocity</strong>
              </td>
              <td>No</td>
              <td>
                Not available in quick create form. Select <b>Create with details</b> or open
                Iteration after creation to enter the expected number of Points.
              </td>
            </tr>
          </tbody>
        </DocTable>
      </Section>
      <Section
        id="lap-planned-velocity"
        number="05.3"
        title="Create Planned Velocity"
        lead="Planned Velocity is the number of Team Points expected to complete in Iteration. This is a manually entered planning goal, not Task hours."
      >
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Open Iteration Detail</strong>
              <p>
                In <b>Plan → Timeboxes → Iterations</b>, select the Iteration ID. If you are
                creating a new one, select <b>Create with details</b>.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Find Planned Velocity school</strong>
              <p>
                This field is in the zone <b>Details</b> on the right, with Start Date, End Date and
                State.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Enter the expected number of Points</strong>
              <p>
                Use numbers from 0 or higher. Can be left blank if the Team has not finalized the
                plan; Do not enter Capacity or Task Estimate hours here.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Check the results</strong>
              <p>
                Return to the Iterations list and confirm the value in the column{' '}
                <b>Planned Velocity</b>. When opening details, the Capacity area also displays this
                target.
              </p>
            </div>
          </li>
        </InstructionList>
        <DocTable columns="fields">
          <thead>
            <tr>
              <th>Index</th>
              <th>Unit</th>
              <th>How to use</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Planned Velocity</strong>
              </td>
              <td>Points</td>
              <td>Team goals expected to be completed in Iteration; enter manually.</td>
            </tr>
            <tr>
              <td>
                <strong>Committed</strong>
              </td>
              <td>Points</td>
              <td>Total Estimate of US/DE is within the Iteration scope; Used to compare plans.</td>
            </tr>
            <tr>
              <td>
                <strong>Accepted</strong>
              </td>
              <td>Points</td>
              <td>Total Estimate Accepted; used to monitor the actual results of the cycle.</td>
            </tr>
            <tr>
              <td>
                <strong>Task Estimate</strong>
              </td>
              <td>Hours</td>
              <td>
                Total Estimate of Tasks; is its own effort metric and does not replace Planned
                Velocity.
              </td>
            </tr>
          </tbody>
        </DocTable>
        <Callout>
          <strong>How to choose the initial number</strong>
          <p>
            Refer to the Velocity of completed Iterations, number of possible participating members,
            and expected US/DE scope. Planned Velocity does not automatically change when you add or
            move Work Items, so update it again if the Team changes its commitment.
          </p>
        </Callout>
      </Section>
      <Section
        id="gan-cong-viec-iteration"
        number="05.4"
        title="Add Work Items to Iteration"
        lead="A User Story or Defect can only belong to a maximum of one Iteration at a time."
      >
        <TaskPrereq>
          <span>BEFORE ASSIGNMENT</span> <strong>Check three things</strong>
          <ul>
            <li>US/DE and Iteration with Project.</li>
            <li>The teams of both sides are suitable.</li>
            <li>You have permission to update Work Item.</li>
          </ul>
        </TaskPrereq>
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Open Work Item</strong>
              <p>
                From <b>Plan → Backlog</b>, select the ID of the User Story or Defect to be planned.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Select the Iteration field</strong>
              <p>Open the list and select the appropriate Iteration in the same Project/Team.</p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Save changes</strong>
              <p>Rova updates existing Work Items; do not create additional copies.</p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Check the results</strong>
              <p>
                Item leaves the Unscheduled Backlog list and appears in{' '}
                <b>Track → Iteration Status</b> of the selected cycle.
              </p>
            </div>
          </li>
        </InstructionList>
        <Callout>
          <strong>Task follows US or Defect parent</strong>
          <p>
            Do not assign Task to separate Iteration. The Task inherits the Iteration of the parent
            Work Item and is tracked in the same cycle.
          </p>
        </Callout>
      </Section>
      <Section
        id="doi-iteration"
        number="05.5"
        title="Change Iteration or return Unscheduled"
        lead="Change the Iteration field on Work Item; Do not delete and recreate items."
      >
        <IterationChangeGrid>
          <article>
            <span>CYCLE TRANSITION</span>
            <h3>Select another Iteration</h3>
            <p>
              Work Item leaves the old Iteration and appears in the new Iteration. The item's ID,
              content, and history are preserved.
            </p>
          </article>
          <article>
            <span>RETURN BACKLOG</span>
            <h3>Select Unscheduled</h3>
            <p>
              Work Item is no longer part of Iteration and reappears in the unscheduled Backlog, if
              not covered by Search or Filters.
            </p>
          </article>
        </IterationChangeGrid>
        <ResultBox>
          <span>EXPECTED RESULTS</span>{' '}
          <strong>Each save has only one active planning scope</strong>
          <p>
            Please check the Backlog or Track → Iteration Status after changing to make sure the
            item is in the right place.
          </p>
        </ResultBox>
      </Section>
      <Section
        id="trang-thai-iteration"
        number="05.6"
        title="Update Iteration status"
        lead="The status reflects the commitment level for the entire cycle, and does not change just because you add a Work Item."
      >
        <IterationStateFlow aria-label="Three states of Iteration">
          <IterationStateCard state="planning">
            <span>01</span>
            <h3>Planning</h3>
            <p>Preparing scope, time and work. This is the normal initialization state.</p>
          </IterationStateCard>
          <IterationStateCard state="committed">
            <span>02</span>
            <h3>Committed</h3>
            <p>
              Team has committed the cycle. Switch status manually; The scope can still be adjusted.
            </p>
          </IterationStateCard>
          <IterationStateCard state="accepted">
            <span>03</span>
            <h3>Accepted</h3>
            <p>
              The cycle has been accepted. When Iteration contains Work Items and all US/DE are
              Accepted, Rova can update this status.
            </p>
          </IterationStateCard>
        </IterationStateFlow>
        <Callout tone="warning">
          <strong>Accepted does not roll back automatically</strong>
          <p>
            If a Work Item is reopened later, check and update the Iteration according to Team
            procedures. Don't rely on automatic reverse changes.
          </p>
        </Callout>
      </Section>
      <Section
        id="xu-ly-iteration"
        number="05.7"
        title="Troubleshooting"
        lead="Check scope, permissions, and data before recreating an Iteration or Work Item."
      >
        <TroubleshootList>
          <article>
            <span>01</span>
            <div>
              <strong>Can't see Plan → Timeboxes</strong>
              <p>
                Check the correct Project and permissions. Iteration creation and management
                function for Workspace Admin or Project Admin.
              </p>
            </div>
          </article>
          <article>
            <span>02</span>
            <div>
              <strong>Can't see Iteration to select</strong>
              <p>
                Check the current Project and Team of the Work Item. List only outputs Iterations
                that match the scope.
              </p>
            </div>
          </article>
          <article>
            <span>03</span>
            <div>
              <strong>Failed to save Iteration</strong>
              <p>
                Check Name, Start Date, End Date and State; Make sure the start date is not later
                than the end date.
              </p>
            </div>
          </article>
          <article>
            <span>05</span>
            <div>
              <strong>Work Item disappeared from Backlog</strong>
              <p>
                This is a normal result after assigning Iteration. Open{' '}
                <b>Track → Iteration Status</b> to find in the corresponding cycle.
              </p>
            </div>
          </article>
          <article>
            <span>06</span>
            <div>
              <strong>Unable to assign Work Item</strong>
              <p>
                Iteration and Work Item may be different from Project or Team. Correct the scope
                accordingly and try again.
              </p>
            </div>
          </article>
          <article>
            <span>07</span>
            <div>
              <strong>Status is not as expected</strong>
              <p>
                Check whether you are reading Iteration State or Work Item status. Assigning
                additional items does not automatically convert Iteration to Committed.
              </p>
            </div>
          </article>
          <article>
            <span>08</span>
            <div>
              <strong>Planned Velocity remains unchanged after adding items</strong>
              <p>
                This is the plan value entered manually. Open Iteration Detail and update again if
                Team changes goals; Don't use hourly Task Estimate instead.
              </p>
            </div>
          </article>
        </TroubleshootList>
        <CheckUnderstanding>
          <strong>Check yourself before moving on to the next section</strong>
          <ul>
            <li>Have you selected the correct Project and Team?</li>
            <li>Does Iteration have a valid date range?</li>
            <li>Did Planned Velocity use the correct Points unit?</li>
            <li>Is US/DE in Iteration or Unscheduled?</li>
            <li>Do you distinguish between Iteration State and Work Item state?</li>
          </ul>
        </CheckUnderstanding>
      </Section>
    </>
  )
}
