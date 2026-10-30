/*
 * English edition, chapter 06-thuc-hien-cong-viec (US-119). Converted from the BA's static page
 * `public/guide/en/06-thuc-hien-cong-viec.html`.
 */
import { GuideShot } from '../../ui/guide-shot'
import {
  ActionGrid,
  Callout,
  ChapterEyebrow,
  ChapterIntro,
  ChapterSummary,
  CheckUnderstanding,
  DefinitionGrid,
  InstructionList,
  IterationStateCard,
  IterationStateFlow,
  Lead,
  ResultBox,
  ScenarioCard,
  ScenarioFlow,
  ScenarioHead,
  Section,
  TroubleshootList,
} from '../../ui/parts'

export default function Chapter() {
  return (
    <>
      <ChapterIntro id="chapter-06">
        <div>
          <ChapterEyebrow>PART 06 · PERFORMING THE WORK</ChapterEyebrow>
          <h2>Monitor execution using Task</h2>
          <Lead>
            Each <strong>Task</strong> is a specific task under User Story or Defect. During the
            work process, you update the person in charge, status and hours directly on the Task.
          </Lead>
        </div>
        <ChapterSummary aria-label="After this part you will be able to do it">
          <strong>After this chapter, you will be able to</strong>
          <ul>
            <li>Opens the Task list of a US or DE.</li>
            <li>Create a child Task and assign it to the correct Owner.</li>
            <li>Update Task State according to actual progress.</li>
            <li>Distinguish between Estimate, To Do and Actual.</li>
            <li>Added description, documentation, and view change history.</li>
          </ul>
        </ChapterSummary>
      </ChapterIntro>
      <Section
        id="mo-task-list"
        number="06.1"
        title="Open the US or Defect Task list"
        lead="Task does not appear as an independent line in the Backlog. Open the parent Work Item and then switch to the Tasks tab."
      >
        <GuideShot
          name="05-tasks-tab-production"
          alt="The Tasks tab displays Add Task, Filters, Show Fields, status, Owner, and hour columns."
          caption="User Story Tasks tab and sub-Tasks list."
        />
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Open US or DE to be performed</strong>
              <p>
                Find the Work Item from Backlog, Iteration Status, Team Status or the Search box on
                the top bar, then select the item ID.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Select the Tasks tab</strong>
              <p>
                The number before the tab name indicates the number of child Tasks present. The list
                only displays Tasks belonging to the currently open Work Item.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Read the Task list</strong>
              <p>
                The main columns include Rank, ID, Name, State, Owner, Project, Teams, To Do,
                Actuals and Estimate. The Totals line adds each hour field separately.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Open the Task to be processed</strong>
              <p>
                Select ID as <b>TA-22</b> to open Task Detail. Here you can update content, status,
                Owner and time.
              </p>
            </div>
          </li>
        </InstructionList>
        <Callout>
          <strong>Task follows the parent Work Item</strong>
          <p>
            Task inherits Project, Team and Iteration from parent US/DE. Task does not have its own
            Iteration and does not appear as an independent item in the Backlog.
          </p>
        </Callout>
      </Section>
      <Section
        id="tao-task-con"
        number="06.2"
        title="Create a child Task"
        lead="Separate US/DE into tasks specific enough that one person can receive and update progress."
      >
        <GuideShot
          name="05-add-task-production"
          alt="Form Create Task with Name, Project, Estimate, To Do, Actuals, Owner and save buttons."
          caption="Add Task Form and fields to fill in."
        />
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Open the Tasks tab and select Add Task</strong>
              <p>
                A new task will be created under the correct open US or DE. Check the parent Work
                Item before importing.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Enter Name</strong>
              <p>
                Write a specific action, for example <b>Build a Priority filter</b>. Name is a
                required field.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Enter the initial time</strong>
              <p>
                Fill in Estimate if there is an estimate. To Do and Actuals can be entered
                separately; Do not enter negative numbers.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Select Owner</strong>
              <p>
                Select a valid member of the parent Team or <b>— No Entry —</b> if the Task has not
                been assigned.
              </p>
            </div>
          </li>
          <li>
            <span>5</span>
            <div>
              <strong>Save Task</strong>
              <p>
                Select <b>Create Task</b> for quick creation. Select <b>Create with details</b> when
                you want to immediately switch to the detail page to add content.
              </p>
            </div>
          </li>
        </InstructionList>
        <ResultBox>
          <span>RESULTS</span> <strong>Task appears in the Tasks tab of the parent US/DE</strong>
          <p>
            Check ID, Name, State, Owner and three hour values in the list. New task uses state{' '}
            <b>Defined</b>.
          </p>
        </ResultBox>
      </Section>
      <Section
        id="giao-task"
        number="06.3"
        title="Assign Task to the right person"
        lead="Owner indicates the main responsible person. The selection list depends on the Team of the parent Work Item."
      >
        <DefinitionGrid>
          <article>
            <span>01</span>
            <div>
              <strong>Owner</strong>
              <p>
                The person responsible for the Task. You can choose when creating or updating in
                Task Detail and Tasks list.
              </p>
            </div>
          </article>
          <article>
            <span>02</span>
            <div>
              <strong>Dev Owner</strong>
              <p>
                Additional field on Task Detail to recognize the developer when the Team process
                uses this role.
              </p>
            </div>
          </article>
          <article>
            <span>03</span>
            <div>
              <strong>— No Entry —</strong>
              <p>
                Used when the Task owner has not been identified. The task is still created but
                needs to be reassigned before tracking the individual.
              </p>
            </div>
          </article>
        </DefinitionGrid>
        <p>
          The Owner list only includes valid members of the parent Team. If you don't see a person,
          check the US/DE Team and that person's membership; Don't change the Team just to make the
          name appear.
        </p>
      </Section>
      <Section
        id="cap-nhat-task-state"
        number="06.4"
        title="Update Task status"
        lead="Task uses its own set of states, shorter than the User Story and Defect states."
      >
        <IterationStateFlow>
          <IterationStateCard>
            <span>1</span>
            <div>
              <h3>Defined</h3>
              <p>Task has been recorded but has not yet started execution.</p>
            </div>
          </IterationStateCard>
          <IterationStateCard>
            <span>2</span>
            <div>
              <h3>In-Progress</h3>
              <p>Task is being executed. Switch to this state when work has actually begun.</p>
            </div>
          </IterationStateCard>
          <IterationStateCard>
            <span>3</span>
            <div>
              <h3>Completed</h3>
              <p>
                Task completed. Check Actual and To Do before closing so that the hours reflect
                reality.
              </p>
            </div>
          </IterationStateCard>
        </IterationStateFlow>
        <p>
          You can change Task State in the Tasks, Task Detail or Team Status tab if you have access
          to that screen. When all child Tasks of the same US/DE are Completed, the system
          automatically converts the parent Work Item to Completed. If you reopen any Task, the Work
          Item will automatically return to In-Progress.
        </p>
        <Callout tone="warning">
          <strong>Changing status does not automatically update the time</strong>
          <p>
            Completed or reopened Task does not change Estimate, To Do or Actual. The executor must
            update the hour values separately.
          </p>
        </Callout>
      </Section>
      <Section
        id="cap-nhat-gio-task"
        number="06.5"
        title="Update Estimate, To Do and Actual"
        lead="Three schools use the same hour unit but answer three different questions."
      >
        <GuideShot
          name="05-task-detail-production"
          alt="Task Detail with Task State, Owner, Dev Owner, Work Product, Estimate, To Do and Actual."
          caption="Task Detail; The right panel contains status, person in charge, and three independent time fields."
        />
        <DefinitionGrid>
          <article>
            <span>01</span>
            <div>
              <strong>Estimate</strong>
              <p>Estimated total number of hours to complete the Task at the time of planning.</p>
            </div>
          </article>
          <article>
            <span>02</span>
            <div>
              <strong>To Do</strong>
              <p>Hours remaining according to the operator's current assessment.</p>
            </div>
          </article>
          <article>
            <span>03</span>
            <div>
              <strong>Actual</strong>
              <p>Number of hours performed and entered directly on Task.</p>
            </div>
          </article>
        </DefinitionGrid>
        <p>
          When creating a Task, if you enter Estimate and leave To Do blank, the system copies
          Estimate to To Do exactly once. Once the Task has been created, the three fields operate
          independently: editing one field does not automatically recalculate the other two fields.
        </p>
        <ScenarioCard>
          <ScenarioHead>
            <span>EXAMPLE</span>
            <div>
              <h3>After a work session</h3>
              <p>Task was created with an Estimate of 6 hours and an initial To Do of 6 hours.</p>
            </div>
          </ScenarioHead>
          <ScenarioFlow>
            <li>
              <span>1</span>
              <div>
                <strong>Worked 2 hours</strong>
                <p>The operator enters Actual = 2.</p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <strong>About 4 hours left</strong>
                <p>The user enters To Do = 4.</p>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <strong>Estimate is still 6</strong>
                <p>The system does not use the required formula Actual + To Do = Estimate.</p>
              </div>
            </li>
          </ScenarioFlow>
        </ScenarioCard>
        <p>
          Task Detail uses field <b>Actual</b> to enter the time directly; This tutorial does not
          use a separate Timesheet or Time Entry screen.
        </p>
      </Section>
      <Section
        id="bo-sung-task"
        number="06.6"
        title="Add information and view history"
        lead="Use Task Detail when you need to specify actions, attach documents, or check changes."
      >
        <ActionGrid>
          <article>
            <span>1</span>
            <div>
              <strong>Description</strong>
              <p>Describe the scope, required results or technical notes of the Task.</p>
            </div>
          </article>
          <article>
            <span>2</span>
            <div>
              <strong>Attachments</strong>
              <p>
                Attach files directly related to work; Avoid giving out passwords or sensitive data.
              </p>
            </div>
          </article>
          <article>
            <span>3</span>
            <div>
              <strong>Linked Items</strong>
              <p>
                Link related items when cross-searching is needed. The parent Work Product is still
                displayed separately in the details panel.
              </p>
            </div>
          </article>
          <article>
            <span>4</span>
            <div>
              <strong>Notes and Comments</strong>
              <p>Notes saves Task notes; Comments are used for communication over time.</p>
            </div>
          </article>
          <article>
            <span>5</span>
            <div>
              <strong>Revision History</strong>
              <p>
                View Task updates, including changes to status, person in charge, or fields, that
                have now been recorded.
              </p>
            </div>
          </article>
        </ActionGrid>
      </Section>
      <Section
        id="xu-ly-task"
        number="06.7"
        title="Troubleshooting"
        lead="Check the parent Work Item, Team and permissions before recreating or editing data."
      >
        <TroubleshootList>
          <article>
            <span>01</span>
            <div>
              <strong>Tasks tab not visible</strong>
              <p>
                Check the open item is User Story or Defect. Task Detail does not have a child Tasks
                tab.
              </p>
            </div>
          </article>
          <article>
            <span>02</span>
            <div>
              <strong>Task not seen in Backlog</strong>
              <p>
                This is normal behavior. Open the parent US/DE or use Team Status to find Tasks by
                Iteration and Owner.
              </p>
            </div>
          </article>
          <article>
            <span>03</span>
            <div>
              <strong>Can't find the person to select in Owner</strong>
              <p>
                Check if that person is a valid member of the parent Team or not. If it cannot be
                delivered, select No Entry and notify the Team manager.
              </p>
            </div>
          </article>
          <article>
            <span>05</span>
            <div>
              <strong>To Do does not decrease when entering Actual</strong>
              <p>
                Two independent fields. Please update To Do according to the remaining reviews
                instead of waiting for the system to automatically subtract.
              </p>
            </div>
          </article>
          <article>
            <span>06</span>
            <div>
              <strong>Time does not change when Completed</strong>
              <p>
                Correct according to current rules. The state does not automatically set To Do to 0
                or change Actual.
              </p>
            </div>
          </article>
          <article>
            <span>07</span>
            <div>
              <strong>US/DE failed to change status automatically</strong>
              <p>
                When all child Tasks are Completed, the parent item is automatically Completed;
                Reopening a Task will return the parent item to In-Progress.
              </p>
            </div>
          </article>
        </TroubleshootList>
        <CheckUnderstanding>
          <strong>Check yourself before moving on to the next section</strong>
          <ul>
            <li>Is the task under the correct US or DE?</li>
            <li>Is Owner part of the parent Work Item's Team?</li>
            <li>Does Task State reflect actual progress?</li>
            <li>Have Estimate, To Do and Actual been updated separately?</li>
          </ul>
        </CheckUnderstanding>
      </Section>
    </>
  )
}
