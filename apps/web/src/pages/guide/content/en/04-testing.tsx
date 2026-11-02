/*
 * English edition, chapter 04-testing (US-119). Converted from the BA's static page
 * `public/guide/en/04-testing.html`.
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
  TemplateLabel,
  TroubleshootList,
  WritingTemplate,
} from '../../ui/parts'

export default function Chapter() {
  return (
    <>
      <ChapterIntro id="chapter-04">
        <div>
          <ChapterEyebrow>PART 04 · TESTING</ChapterEyebrow>
          <h2>Create Test Case and record test results</h2>
          <Lead>
            <strong>Test Case</strong> describes what to test for a User Story or Defect.{' '}
            <strong>Test Result</strong> records the results of each run on a particular Build.
          </Lead>
        </div>
        <ChapterSummary aria-label="After this part you will be able to do it">
          <strong>After this chapter, you will be able to</strong>
          <ul>
            <li>Open the US/DE Test Case list.</li>
            <li>Create and complete a Test Case.</li>
            <li>Record Test Result for each run.</li>
            <li>Read Last Verdict, Last Run and history.</li>
            <li>Manage Test Case Type by Project.</li>
          </ul>
        </ChapterSummary>
      </ChapterIntro>
      <Section
        id="hieu-luong-testing"
        number="04.1"
        title="Understand the Testing flow"
        lead="Testing starts from the Work Item needs to verify and keep test content separate from the results of each run."
      >
        <WritingTemplate aria-label="Relationship between Work Item, Test Case and Test Result">
          <strong>User Story or Defect → Test Case → Test Result</strong>
          <p>
            <TemplateLabel>Work Item</TemplateLabel>Indicates a need or error that needs
            verification. A US/DE can have many Test Cases.
          </p>
          <p>
            <TemplateLabel>Test Case</TemplateLabel>Describes the goal, conditions, input data, and
            expected results. Test Cases are always linked to an existing Work Product.
          </p>
          <p>
            <TemplateLabel>Test Result</TemplateLabel>Record Build, run date, Verdict, duration and
            Tester of an execution. A Test Case can have many Results.
          </p>
        </WritingTemplate>
        <p>
          <strong>Do not overwrite Test Case to save run results.</strong> When running again on
          another Build, add a new Result to preserve the previous Pass, Fail or Blocked history.
        </p>
      </Section>
      <Section
        id="mo-test-cases"
        number="04.2"
        title="Open Work Item Test Cases"
        lead="Test Cases are located in the User Story or Defect details page, right after the Tasks tab."
      >
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Open User Story or Defect</strong>
              <p>
                From Backlog, Iteration Status or Quality, select the ID of the Work Item to be
                tested.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Select the Test Cases tab</strong>
              <p>The number on the tab shows how many Test Cases are linked to the Work Item.</p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Read the list</strong>
              <p>
                Use Search, Filters and Show Fields when the list is long. Select Test Case ID to
                open the details.
              </p>
            </div>
          </li>
        </InstructionList>
        <DocTable>
          <thead>
            <tr>
              <th>Column</th>
              <th>Meaning</th>
              <th>How to use</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Name</strong>
              </td>
              <td>Brief test objectives.</td>
              <td>Read Name first to avoid creating Test Case with the same target.</td>
            </tr>
            <tr>
              <td>
                <strong>Type / Method</strong>
              </td>
              <td>Test type and execution method: Manual or Automated.</td>
              <td>Used to find and group appropriate Test Cases.</td>
            </tr>
            <tr>
              <td>
                <strong>Priority / Owner</strong>
              </td>
              <td>Priority and responsible person.</td>
              <td>Check before starting execution.</td>
            </tr>
            <tr>
              <td>
                <strong>Last Verdict</strong>
              </td>
              <td>Verdict of latest Result.</td>
              <td>Indicates the most recent test status, does not replace Result history.</td>
            </tr>
            <tr>
              <td>
                <strong>Last Run</strong>
              </td>
              <td>Date of latest Result.</td>
              <td>Used to identify whether a Test Case has been run recently or not.</td>
            </tr>
          </tbody>
        </DocTable>
      </Section>
      <Section
        id="tao-test-case"
        number="04.3"
        title="Create Test Case"
        lead="Create Test Case from US/DE itself so that Rova can properly link Work Product, Project and Team."
      >
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Select Add New</strong>
              <p>
                In tab <b>Test Cases</b>, select <b>Add New</b> to open the Create Test Case form.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Enter Name</strong>
              <p>
                Write a clear, concise test objective. The Create button is locked when Name is
                empty.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Check classification information</strong>
              <p>
                Select the appropriate Type, Method, Priority, Owner and Assigned To. Project is
                taken from the current Work Item.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Create and open details</strong>
              <p>
                Select <b>Create</b>. The new Test Case is associated with US/DE and starts in an
                unrun state.
              </p>
            </div>
          </li>
        </InstructionList>
        <DocTable>
          <thead>
            <tr>
              <th>Field</th>
              <th>How to enter</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Name</strong>
              </td>
              <td>State the main behavior or condition to be verified.</td>
              <td>Required; Each Test Case should have one main goal.</td>
            </tr>
            <tr>
              <td>
                <strong>Type</strong>
              </td>
              <td>
                Select a Type configured for the Project, such as Acceptance, Functional, or
                Regression.
              </td>
              <td>Type list is configured for each Project.</td>
            </tr>
            <tr>
              <td>
                <strong>Method</strong>
              </td>
              <td>Select Manual or Automated.</td>
              <td>Reflects how the Test Case is executed.</td>
            </tr>
            <tr>
              <td>
                <strong>Priority</strong>
              </td>
              <td>Select Low, Normal, High or Urgent.</td>
              <td>Priority represents the order in which to test.</td>
            </tr>
            <tr>
              <td>
                <strong>Owner</strong>
              </td>
              <td>Select the person responsible for the Test Case.</td>
              <td>Different from Assigned To.</td>
            </tr>
            <tr>
              <td>
                <strong>Assigned To</strong>
              </td>
              <td>Select the person being assigned to do it or leave it Unassigned.</td>
              <td>Can be changed later on Test Case Detail.</td>
            </tr>
          </tbody>
        </DocTable>
      </Section>
      <Section
        id="hoan-thien-test-case"
        number="04.4"
        title="Complete Test Case content"
        lead="Fill in the conditions, inputs, and expected results so others can run it again without asking further questions."
      >
        <DocTable>
          <thead>
            <tr>
              <th>Contents</th>
              <th>Should write</th>
              <th>Should be avoided</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Description</strong>
              </td>
              <td>Summary of scope and behavior to test.</td>
              <td>Repeat Name without adding context.</td>
            </tr>
            <tr>
              <td>
                <strong>Objective</strong>
              </td>
              <td>State target or verified Acceptance Criteria.</td>
              <td>Merge multiple unrelated targets.</td>
            </tr>
            <tr>
              <td>
                <strong>Preconditions</strong>
              </td>
              <td>Record permissions, data, Project, Team and status required before running.</td>
              <td>Using implicit conditions that the Tester does not know.</td>
            </tr>
            <tr>
              <td>
                <strong>Input</strong>
              </td>
              <td>Write operations and test data in the correct order.</td>
              <td>Write generically like “function test”.</td>
            </tr>
            <tr>
              <td>
                <strong>Expected Result</strong>
              </td>
              <td>State observable and comparable results.</td>
              <td>Use vague words like “functions properly”.</td>
            </tr>
            <tr>
              <td>
                <strong>Postconditions</strong>
              </td>
              <td>Indicates remaining data or status after running.</td>
              <td>Ignore data that needs to be cleaned or restored.</td>
            </tr>
            <tr>
              <td>
                <strong>Notes / Attachments</strong>
              </td>
              <td>Add necessary instructions, files or evidence.</td>
              <td>Put the Pass/Fail conclusion here instead of Result.</td>
            </tr>
          </tbody>
        </DocTable>
        <p>
          <strong>Rova does not have a separate Test Steps list.</strong> Please use the pair{' '}
          <b>Input</b> and <b>Expected Result</b> to describe the test step and the results to
          observe.
        </p>
      </Section>
      <Section
        id="ghi-test-result"
        number="04.5"
        title="Record a Test Result"
        lead="Each Result represents one Test Case run on a Build and does not replace previous Results."
      >
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Open Test Case Detail</strong>
              <p>
                Select tab <b>Results</b>; The number on the tab is the total saved Result.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Select Add Result</strong>
              <p>
                Rova automatically populates the current Test Case and Work Product as read-only.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Enter run information</strong>
              <p>Enter Build, Date, Verdict, Duration, Tester and Notes as needed.</p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Save Result</strong>
              <p>
                Select <b>Save</b>. New results are added to the history and old results are not
                deleted.
              </p>
            </div>
          </li>
          <li>
            <span>5</span>
            <div>
              <strong>Check roll-up</strong>
              <p>
                Go back to Test Case and confirm Last Verdict, Last Run reflects the latest Result.
              </p>
            </div>
          </li>
        </InstructionList>
        <DocTable>
          <thead>
            <tr>
              <th>Field</th>
              <th>How to enter</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Build</strong>
              </td>
              <td>Name or code of the instance under test.</td>
              <td>Required; Use uniform conventions for easy tracking.</td>
            </tr>
            <tr>
              <td>
                <strong>Date</strong>
              </td>
              <td>Actual date of test execution.</td>
              <td>Affects the Result that is considered the latest.</td>
            </tr>
            <tr>
              <td>
                <strong>Verdict</strong>
              </td>
              <td>Select Pass, Fail, Blocked, Error or Inconclusive.</td>
              <td>Only select Pass when it has run and has enough evidence.</td>
            </tr>
            <tr>
              <td>
                <strong>Duration</strong>
              </td>
              <td>Minutes taken; Use numbers from 0 and above.</td>
              <td>Do not enter hour in minute field.</td>
            </tr>
            <tr>
              <td>
                <strong>Tester</strong>
              </td>
              <td>The person who made the run.</td>
              <td>Different Owner and Assigned To of Test Case.</td>
            </tr>
            <tr>
              <td>
                <strong>Notes</strong>
              </td>
              <td>Record data, environment, blocker or additional evidence.</td>
              <td>Do not use Notes instead of Build or Verdict.</td>
            </tr>
          </tbody>
        </DocTable>
      </Section>
      <Section
        id="doc-ket-qua-testing"
        number="04.6"
        title="Read results and history"
        lead="Read Last Verdict for the most recent results, then open Results when you need to understand the entire run history."
      >
        <p>
          <strong>Last Verdict</strong> gets the Verdict of the latest Result.{' '}
          <strong>Last Run</strong> gets the date of that Result. If two results have the same date,
          Rova uses the date of creation to determine the newer version.
        </p>
        <DocTable>
          <thead>
            <tr>
              <th>Area</th>
              <th>Indicates</th>
              <th>When to use</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Test Cases list</strong>
              </td>
              <td>Last Verdict and Last Run of each Test Case.</td>
              <td>Quickly check coverage and latest status.</td>
            </tr>
            <tr>
              <td>
                <strong>Results list</strong>
              </td>
              <td>Build, Date, Work Product, Verdict, Duration and Tester of each run.</td>
              <td>Compare results between multiple Builds or runs.</td>
            </tr>
            <tr>
              <td>
                <strong>Result Detail</strong>
              </td>
              <td>Information and attachments of a specific Result.</td>
              <td>Investigate Fail, Blocked, Error or Inconclusive.</td>
            </tr>
            <tr>
              <td>
                <strong>Revision History</strong>
              </td>
              <td>Changes recorded on Test Case or Result.</td>
              <td>Trace who changed the data and what changed.</td>
            </tr>
          </tbody>
        </DocTable>
      </Section>
      <Section
        id="quan-ly-test-case-type"
        number="04.7"
        title="Manage Test Case Type"
        lead="Workspace Admin manages a separate Type list for each Project."
      >
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Open Project</strong>
              <p>
                Enter <b>Settings → Workspaces & Projects</b>, select the Project to configure and
                open the tab <b>Details</b>.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Find Test Case Types</strong>
              <p>
                The new project has default Types: Acceptance, Functional, Regression, Performance
                and Usability.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Add Type</strong>
              <p>
                Select <b>Add New</b>, enter a unique name in Project and then save.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Stop using Type</strong>
              <p>
                Select Remove and confirm. Type no longer appears when creating a new one; Old Test
                Cases still retain historical value.
              </p>
            </div>
          </li>
        </InstructionList>
      </Section>
      <Section
        id="xu-ly-testing"
        number="04.8"
        title="Troubleshooting"
        lead="Check the latest Work Product, required data and Result before recreating the record."
      >
        <TroubleshootList>
          <article>
            <span>01</span>
            <div>
              <strong>Test Cases tab not visible</strong>
              <p>
                Confirm you have the User Story or Defect Detail open and have permission to view
                the Work Item in that Project/Team.
              </p>
            </div>
          </article>
          <article>
            <span>02</span>
            <div>
              <strong>Create is locked</strong>
              <p>
                Enter Name and check Type, Method, Priority, Owner, Assigned To before creating.
              </p>
            </div>
          </article>
          <article>
            <span>03</span>
            <div>
              <strong>Test Case is not correct Work Product</strong>
              <p>
                Go back to US/DE and create it from the Test Cases tab of that same Work Item; Do
                not create another copy to cover the link error.
              </p>
            </div>
          </article>
          <article>
            <span>05</span>
            <div>
              <strong>Save Result is locked</strong>
              <p>Check Build, Date and Tester. Duration cannot be less than 0.</p>
            </div>
          </article>
          <article>
            <span>06</span>
            <div>
              <strong>Last Verdict was not as expected</strong>
              <p>
                Open the Results list and check Date. Last Verdict takes the latest Result, not the
                just opened Result.
              </p>
            </div>
          </article>
          <article>
            <span>07</span>
            <div>
              <strong>Can't see the Type to select</strong>
              <p>
                Ask Workspace Admin to check the Test Case Types of the correct Project; Type may
                have been discontinued.
              </p>
            </div>
          </article>
        </TroubleshootList>
        <CheckUnderstanding>
          <strong>Check your understanding</strong>
          <ul>
            <li>Is the Test Case linked to the correct User Story or Defect?</li>
            <li>Is Input and Expected Result enough for others to run again?</li>
            <li>Is the Result correct for Build, Date, Verdict and Tester?</li>
            <li>Are you reading the latest result or a historical result?</li>
          </ul>
        </CheckUnderstanding>
      </Section>
    </>
  )
}
