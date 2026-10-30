/*
 * English edition, chapter 07-loi-theo-doi-team (US-119). Converted from the BA's static page
 * `public/guide/en/07-loi-theo-doi-team.html`.
 */
import { GuideShot } from '../../ui/guide-shot'
import {
  Callout,
  ChapterEyebrow,
  ChapterIntro,
  ChapterSummary,
  CheckUnderstanding,
  InstructionList,
  Lead,
  Section,
  TroubleshootList,
} from '../../ui/parts'

export default function Chapter() {
  return (
    <>
      <ChapterIntro id="chapter-07">
        <div>
          <ChapterEyebrow>PART 07 · ERRORS AND TEAM MONITORING</ChapterEyebrow>
          <h2>Track defects and Team progress</h2>
          <Lead>
            <strong>Quality {'>'} Defects</strong> focuses all Defects of the currently selected
            scope. <strong>Track {'>'} Team Status</strong> group Tasks according to the person in
            charge so that the manager can see the volume and progress of the Team in an Iteration.
          </Lead>
        </div>
        <ChapterSummary aria-label="After this part you will be able to do it">
          <strong>After this chapter, you will be able to</strong>
          <ul>
            <li>Open and read the Defect list in Quality.</li>
            <li>Create Defect from the Quality screen.</li>
            <li>Distinguish Severity, Priority, State and Flow State.</li>
            <li>Read Team Status by Iteration and Owner.</li>
            <li>Check the relationship between Task and parent Work Item progress.</li>
          </ul>
        </ChapterSummary>
      </ChapterIntro>
      <Section
        id="mo-quality-defect"
        number="07.1"
        title="Open Quality Defects"
        lead="Use this screen when you need to view errors separately instead of filtering Defects in the Backlog."
      >
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Check Project and Team</strong>
              <p>
                Defect displays according to the currently selected scope on the top bar. Select the
                correct Project and Team before reading data or creating new ones.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Open Quality {'>'} Defects</strong>
              <p>
                The screen has an overview area and a Defect list. When the scope has no defects,
                the system displays <b>No defects logged yet</b>; This is not a data loading error.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Read key columns</strong>
              <p>
                The list includes Rank, ID, Name, User Story, Severity, Priority, State, Flow State,
                Fixed In Build, Iteration, Submitted By and Owner.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Find and narrow results</strong>
              <p>
                Use Search defects, Filters and Show Fields. Pagination at the bottom of the table
                only changes the number of lines in view.
              </p>
            </div>
          </li>
        </InstructionList>
        <p>
          Defect in Quality and Defect in Backlog are <strong>same Work Item</strong>. Changes in
          one screen must be reflected in the other screen; Don't create copies just for monitoring
          in Quality.
        </p>
      </Section>
      <Section
        id="tao-defect-quality"
        number="07.2"
        title="Create Defect from Quality"
        lead="Use Add New when you detect an error and want to record it directly in the specialized screen."
      >
        <GuideShot
          name="03-quality-defects-production"
          alt="Form Add New Defect with Title, Description, Severity, Priority, Found In, Root Cause, Assignee, Release and User Story."
          caption="Add New form at Quality > Defects and error description fields."
        />
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Select Add New</strong>
              <p>
                The quick creation form opens directly above the Quality list. Double-check the
                scope in the top bar before entering.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Enter Title and Description</strong>
              <p>
                Title briefly states the error symptom. Description should include conditions,
                reproduction steps, expected results and actual results.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Select level and handler</strong>
              <p>
                Select Severity, Priority, Assignee and related information if known. The undefined
                field can be left blank and added later.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Link User Story if appropriate</strong>
              <p>
                User Story is optional. Only active Story links within the same Project; Don't
                choose a Story just because the name is similar.
              </p>
            </div>
          </li>
          <li>
            <span>5</span>
            <div>
              <strong>Select Add New to save</strong>
              <p>
                After creating, open Defect Detail to check State, Flow State, Team, Iteration and
                other fields that need to be added.
              </p>
            </div>
          </li>
        </InstructionList>
        <p>
          <strong>Expected result:</strong> New Defect appears in Quality and Backlog with the same
          ID. If you need to create more details from the beginning, you can also create a Defect
          from the Backlog following the instructions in Part 03.
        </p>
      </Section>
      <Section
        id="phan-loai-defect"
        number="07.3"
        title="Classify Defect to process in the correct order"
        lead="Each field answers a different question. Do not use Priority instead of Severity."
      >
        <p>
          <strong>Severity</strong> describes the level of impact of the error on the product: None,
          Critical, Major Problem, Minor Problem or Trivial. Choose according to the practical
          consequences, for example data loss or main thread blocking is more serious than a small
          display error.
        </p>
        <p>
          <strong>Priority</strong> describes the order to be processed: None, Urgent, High, Normal
          or Low. A high Severity error may not be the first priority if it does not affect the
          assigned scope; Priority decisions need to be based on current plans and risks.
        </p>
        <p>
          <strong>User Story</strong> indicates which need the error is directly related to. This
          link is not required and only accepts Stories within the same Project.{' '}
          <strong>Fixed In Build</strong> is hand-entered information about the build or version
          with the fix; Only fill in when you have identified that build.
        </p>
        <Callout>
          <strong>Owner still depends on Team scope</strong>
          <p>
            People with permission to create Defect do not automatically appear in the Owner list.
            The name list still follows Project, Team and membership like User Story.
          </p>
        </Callout>
      </Section>
      <Section
        id="vong-doi-defect"
        number="07.4"
        title="Update Defect lifecycle"
        lead="Defect has its own State to track the error handling process, while still having the Work Item's Flow State."
      >
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Submitted</strong>
              <p>Error has just been reported and is awaiting review.</p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Open</strong>
              <p>The error has been accepted for analysis or processing.</p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Fixed</strong>
              <p>The fix is available and awaiting confirmation.</p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Closed</strong>
              <p>The fix has been confirmed and the bug is closed.</p>
            </div>
          </li>
          <li>
            <span>5</span>
            <div>
              <strong>Closed Declined</strong>
              <p>
                Used when deciding not to handle the error and need to keep the record and reason.
              </p>
            </div>
          </li>
        </InstructionList>
        <p>
          <strong>Flow State</strong> uses the values Idea, Defined, In-Progress, Completed,
          Accepted and Release. Flow State serves the workflow; Defect State serves the defect
          lifecycle. The two independent fields should change the Flow State but not the Defect
          State themselves.
        </p>
        <p>
          Closed and Closed Declined are used when you need to keep Defect as history. Deleting
          Defect is another operation, requiring correct permissions and confirmation steps. This
          guide does not require reopening a Closed or Closed Declined Defect because the reopen
          rule is not within the confirmed scope.
        </p>
      </Section>
      <Section
        id="doc-team-status"
        number="07.5"
        title="Read Team Status by Iteration"
        lead="Use Track > Team Status to view Tasks assigned to each member and the total number of hours in an Iteration."
      >
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Choose the right Team</strong>
              <p>
                Team Status takes members from the currently selected Team. All Teams is a general
                view, not a Team to assign a Task.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Open Track {'>'} Team Status</strong>
              <p>
                The screen is only available to Workspace Admin and Project Admin according to
                current permissions. Editor manages Tasks from the Tasks tab of the Work Item and
                does not go to Team Status.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Select Iteration</strong>
              <p>
                Use the previous button, the Iteration list and the following button at the top of
                the page. Changing Iteration will change the entire group member, Task and total
                number.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Read the Totals line</strong>
              <p>
                Totals adds Capacity, Estimate, To Do and Actuals of the entire Iteration scope, not
                just the lines on the current paging page.
              </p>
            </div>
          </li>
          <li>
            <span>5</span>
            <div>
              <strong>Open the member group</strong>
              <p>
                Each group displays name, Task number, progress percentage and hours. Open the group
                to see Task ID, Task Name, Work Product, Release, State and Owner.
              </p>
            </div>
          </li>
        </InstructionList>
        <p>
          Team Status has <strong>Filters</strong> and paging; There is no separate Search Tasks or
          Show Fields box. Tasks without an Owner are grouped below <strong>Unassigned</strong> with
          Capacity equal to 0 hours.
        </p>
      </Section>
      <Section
        id="kiem-tra-rollup"
        number="07.6"
        title="Check progress of Work Item parent"
        lead="Team Status displays the Task, while the overall progress is reflected in the parent User Story or Defect."
      >
        <p>
          Each Task in Team Status belongs to exactly one User Story or Defect recorded in the
          column <strong>Work Product</strong>. Task inherits Iteration from parent Work Item and is
          calculated exactly once within the selected scope.
        </p>
        <p>
          When a Task moves to Completed, the system updates the progress of the parent Work Item.
          If there is still a Task that has not been completed, the parent item has not completed
          itself. When all child Tasks are Completed, the parent item automatically switches to
          Completed.
        </p>
        <p>
          If you reopen a Task to Defined or In-Progress, the parent item automatically switches
          back to In-Progress and recalculates the progress. Estimate, To Do and Actual of the Task
          remain the same; Changing State does not automatically edit the time fields.
        </p>
        <CheckUnderstanding>
          <strong>Quickly check when the data does not match</strong>
          <ul>
            <li>Is the Task under the correct US/DE and correct Iteration?</li>
            <li>
              Does the Task have an Owner belonging to the currently selected Team or is it
              Unassigned?
            </li>
            <li>Are there any child Tasks that are not Completed?</li>
            <li>Have Estimate, To Do and Actual been updated separately?</li>
          </ul>
        </CheckUnderstanding>
      </Section>
      <Section
        id="xu-ly-chat-luong-team"
        number="07.7"
        title="Troubleshooting"
        lead="Check the scope and data source before recreating a Defect or Task."
      >
        <TroubleshootList>
          <article>
            <span>01</span>
            <div>
              <strong>Quality has no Defect</strong>
              <p>
                Check Project, Team, Search and Filters. If the screen says No defects logged yet
                after removing the filter, the current scope does not have a Defect.
              </p>
            </div>
          </article>
          <article>
            <span>02</span>
            <div>
              <strong>Defect is in Backlog but not in Quality</strong>
              <p>
                Compare with Project/Team and remove filter. The two screens use the same Defect
                data so no replacement items are created.
              </p>
            </div>
          </article>
          <article>
            <span>03</span>
            <div>
              <strong>Unable to select User Story</strong>
              <p>
                Story must be active, in the same Project and within the scope of your access. The
                link can be left blank if the error does not belong to a specific Story.
              </p>
            </div>
          </article>
          <article>
            <span>05</span>
            <div>
              <strong>Unable to open Team Status</strong>
              <p>
                Editor does not have permission to access this screen. Use the Tasks tab of Work
                Item or contact Project Admin when you need to view Team summary.
              </p>
            </div>
          </article>
          <article>
            <span>06</span>
            <div>
              <strong>Can't see members in Team Status</strong>
              <p>
                The list only takes active members of the currently selected Team. People outside
                the Team cannot create a new member group.
              </p>
            </div>
          </article>
          <article>
            <span>07</span>
            <div>
              <strong>Total hours do not change when changing State</strong>
              <p>
                This is correct behavior. Update Estimate, To Do and Actual directly on Task; State
                only reflects the execution phase.
              </p>
            </div>
          </article>
        </TroubleshootList>
      </Section>
    </>
  )
}
