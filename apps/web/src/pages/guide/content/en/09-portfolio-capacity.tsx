/*
 * English edition, chapter 09-portfolio-capacity (US-119). Converted from the BA's static page
 * `public/guide/en/09-portfolio-capacity.html`.
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
      <ChapterIntro id="chapter-09">
        <div>
          <ChapterEyebrow>PART 09 · PORTFOLIO & CAPACITY</ChapterEyebrow>
          <h2>From big goals to realistic capacity plans</h2>
          <Lead>
            <strong>Portfolio Items</strong> organizes goals according to the sequence Epic →
            Feature → User Story/Defect. <strong>Capacity Planning</strong> allocates the Feature of
            a Release to Teams in the plan without changing the Feature's original Project or
            Implementation Team.
          </Lead>
        </div>
        <ChapterSummary aria-label="After this part you will be able to do it">
          <strong>After this chapter, you will be able to</strong>
          <ul>
            <li>Select the correct scope when viewing Epic or Feature.</li>
            <li>Create and update Portfolio Item to correct level.</li>
            <li>Read progress by Estimate and Count.</li>
            <li>Create Capacity Plan according to a Release.</li>
            <li>Allocate Feature, Publish and reopen Plan when needed.</li>
          </ul>
        </ChapterSummary>
      </ChapterIntro>
      <Section
        id="mo-portfolio-items"
        number="09.1"
        title="Open Portfolio Items in the correct scope"
        lead="Team scope determines the type of Portfolio Items you can view."
      >
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Select the correct Project</strong>
              <p>
                Open the context selector on the top bar and select the Project you want to manage.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Select Team or All Teams</strong>
              <p>
                Use <b>All Teams</b> when viewing Project-level Epic. Select a specific Team when
                focusing on that Team's Feature.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Open Portfolio → Portfolio Items</strong>
              <p>
                Select Type = Epic or Feature. Use Search portfolio, Filters and Show Fields to
                narrow down the list.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Check the selected scope header</strong>
              <p>Reconcile Project · Team on top before creating, editing or archiving.</p>
            </div>
          </li>
        </InstructionList>
        <p>
          <strong>Epic only appears in All Teams.</strong> While on a specific Team, Type = Epic may
          not display data. This is scoped behavior, not lost Epic.
        </p>
        <p>
          Workspace Admin and Project Admin can manage Portfolio Items within the granted scope.
          Editors or accounts that do not have Project rights do not use this screen.
        </p>
      </Section>
      <Section
        id="phan-biet-epic-feature"
        number="09.2"
        title="Distinguishing between Epic and Feature"
        lead="Choose the right level to avoid bringing a large target to the Team or creating a Feature that is too broad."
      >
        <DocTable>
          <thead>
            <tr>
              <th>Object</th>
              <th>Used to describe</th>
              <th>Scope and binding</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Epic</strong>
              </td>
              <td>
                Big goal at Project level, used to group Features with the same result direction.
              </td>
              <td>
                Belongs to a Project; There is no direct Team and Release. Can contain multiple
                Features.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Feature</strong>
              </td>
              <td>Product capabilities can be deployed and progress tracked by the Team.</td>
              <td>
                Belongs to a Project; You can choose Team, Epic, Release and Owner. US/DE links
                directly to Feature.
              </td>
            </tr>
          </tbody>
        </DocTable>
        <p>
          <strong>Capacity Planning only allocates Features.</strong> Epic is used to guide and
          synthesize progress; Do not include Epic in the Capacity Plan.
        </p>
        <p>
          Archive still holds history. Epics are only archived when there are no active child
          Features; This operation does not automatically archive child features.
        </p>
      </Section>
      <Section
        id="tao-cap-nhat-portfolio"
        number="09.3"
        title="Create and update Portfolio Item"
        lead="Prepare the correct Project, Owner and parentage before saving."
      >
        <DocTable>
          <thead>
            <tr>
              <th>When creating</th>
              <th>Main field</th>
              <th>Point to check</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Epic</strong>
              </td>
              <td>Name, Project, Owner, State, Preliminary Estimate.</td>
              <td>Do not select Team or Release.</td>
            </tr>
            <tr>
              <td>
                <strong>Feature</strong>
              </td>
              <td>Name, Owner, Team, Release, Epic, State, Preliminary Estimate, Description.</td>
              <td>Epic, Team and Release must be the same Project.</td>
            </tr>
          </tbody>
        </DocTable>
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Select the Type to create</strong>
              <p>
                On Portfolio Items, select Epic or Feature and then use the corresponding New
                button.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Enter Name and Owner</strong>
              <p>
                The name should describe the desired result. The Owner list depends on valid rights
                and membership.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Complete the relationship</strong>
              <p>
                For Feature, select Team, Release and Epic once defined. Select Epic = Unassigned if
                there is no parent Epic.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Choose how to complete</strong>
              <p>
                Create saves and returns to the list. Create with details opens the details page to
                add Description, Notes, Attachments and What Success Looks Like.
              </p>
            </div>
          </li>
          <li>
            <span>5</span>
            <div>
              <strong>Check Children</strong>
              <p>
                Epic Children show Feature; Feature Children shows the User Story/Defect and Task
                below.
              </p>
            </div>
          </li>
        </InstructionList>
        <p>
          <strong>Feature does not have its own Plan Estimate.</strong> Preliminary Estimate and
          Refined Estimate are Feature-level estimates; Plan Estimate is located in User
          Story/Defect and is used for rollups.
        </p>
      </Section>
      <Section
        id="doc-tien-do-portfolio"
        number="09.4"
        title="Read Portfolio progress"
        lead="The two percentage columns answer two different questions."
      >
        <DocTable>
          <thead>
            <tr>
              <th>Index</th>
              <th>How to understand</th>
              <th>When appropriate</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>% Done by Est.</strong>
              </td>
              <td>Plan Estimate of US/DE in Accepted or Release divided by total Plan Estimate.</td>
              <td>When items have different sizes and Plan Estimate is fully entered.</td>
            </tr>
            <tr>
              <td>
                <strong>% Done by Count</strong>
              </td>
              <td>Number of US/DE in Accepted or Release divided by total number of US/DE.</td>
              <td>When you need to quickly read the number of completed items.</td>
            </tr>
          </tbody>
        </DocTable>
        <p>
          With Feature, data taken from US/DE links directly. With Epic, aggregated data from US/DE
          belongs to active sub-Features. Tasks are not counted directly.
        </p>
        <p>
          <strong>Completed is not Accepted in Portfolio.</strong> US/DE only enters the numerator
          when in Accepted or Release.
        </p>
        <p>
          When the denominator is 0, the interface displays 0%. Please open Children to check for
          items that are missing Plan Estimate or have no data before concluding.
        </p>
      </Section>
      <Section
        id="tao-capacity-plan"
        number="09.5"
        title="Create Capacity Plan"
        lead="Each Plan belongs to a Project, references a Release and uses a fixed unit."
      >
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Open Portfolio → Capacity Planning</strong>
              <p>
                Check Project on the top bar. Use Search plans, Filters or Show Fields when the list
                has many Plans.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Select Add New</strong>
              <p>
                The form displays Project, Plan Type = Single Release and Portfolio Item Type =
                Feature.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Enter Name and select Release</strong>
              <p>
                Release is required and must belong to the current Project. Each Project + Release
                pair has only one Capacity Plan.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Select Unit</strong>
              <p>
                Select <b>points</b> to use Plan Estimate or <b>items</b> to use quantity. Units
                cannot be changed after creation.
              </p>
            </div>
          </li>
          <li>
            <span>5</span>
            <div>
              <strong>Select Create</strong>
              <p>The new Plan is in Draft state and has not yet added Teams or Features.</p>
            </div>
          </li>
        </InstructionList>
      </Section>
      <Section
        id="phan-bo-capacity"
        number="09.6"
        title="Allocate Feature and Capacity to Team"
        lead="Allocation only exists in the Plan and does not change the Feature's original Project or Team."
      >
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Add Team to Plan</strong>
              <p>
                Use Add Team and select Team under Project. Capacity is entered manually for this
                Plan and defaults to 0.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Add Feature</strong>
              <p>
                Add from the Features tab to include Not assigned, or add from an open Team to
                pre-assign that Team.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Assign or divide allocation</strong>
              <p>
                Use Planned Team Assignment for a Team. Use Allocate when dividing a Feature among
                multiple Teams.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Read Demand and Capacity</strong>
              <p>
                Demand is the total allocation of the Team. Compare Complete, Rollup, Estimated and
                Capacity to identify over- or under-estimation.
              </p>
            </div>
          </li>
          <li>
            <span>5</span>
            <div>
              <strong>Adjust as needed</strong>
              <p>
                Unassign keeps the Feature in Plan and returns it to Not assigned. Remove from Plan
                removes all allocations but does not archive Features.
              </p>
            </div>
          </li>
        </InstructionList>
        <p>
          <strong>Warning is advisory only.</strong> Rollup greater than Estimated, Demand greater
          than Capacity or missing estimate need to be considered; The system is not self-balanced.
        </p>
        <p>
          Capacity Forecast is a support tool in Draft. The value is applied only when the user
          confirms it and is not continuously recalculated.
        </p>
      </Section>
      <Section
        id="publish-capacity-plan"
        number="09.7"
        title="Publish and reopen Capacity Plan"
        lead="Check the selected scope, total Capacity and warnings before locking Plan."
      >
        <DocTable>
          <thead>
            <tr>
              <th>Action</th>
              <th>Result</th>
              <th>Point to remember</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Publish Without Updating Fields</strong>
              </td>
              <td>Switch Plan to Published and change visibility.</td>
              <td>Do not copy Release or planning date to Feature.</td>
            </tr>
            <tr>
              <td>
                <strong>Publish</strong>
              </td>
              <td>
                Switch to Published and update the Feature fields allowed when the date condition is
                valid.
              </td>
              <td>Do not change Feature's Project/Team and do not update US/DE.</td>
            </tr>
            <tr>
              <td>
                <strong>Revert to Draft</strong>
              </td>
              <td>Unlock Plan to continue editing.</td>
              <td>Do not automatically undo values copied in the previous Publish.</td>
            </tr>
          </tbody>
        </DocTable>
        <p>
          <strong>Published is read-only.</strong> If you want to add Team, change Capacity, add
          Feature or edit allocation, Admin must Revert to Draft first.
        </p>
        <p>
          If the Plan date does not match the Release, the system can still Publish the visibility
          but cannot silently overwrite the Release on the Feature. Please read the results notice
          before leaving the page.
        </p>
      </Section>
      <Section
        id="xu-ly-portfolio-capacity"
        number="09.8"
        title="Troubleshooting"
        lead="Check scope, permissions, and status before regenerating data."
      >
        <TroubleshootList>
          <article>
            <span>01</span>
            <div>
              <strong>Epic not found</strong>
              <p>Switch to All Teams, select Type = Epic and uncheck Search/Filters.</p>
            </div>
          </article>
          <article>
            <span>02</span>
            <div>
              <strong>Feature or Owner not found</strong>
              <p>
                Check Project, Team, permissions and membership. The options in the form must be in
                the same Project.
              </p>
            </div>
          </article>
          <article>
            <span>03</span>
            <div>
              <strong>Unable to archive Epic</strong>
              <p>
                Epic still has active child Feature. Remove the relationship or process the child
                Feature first.
              </p>
            </div>
          </article>
          <article>
            <span>05</span>
            <div>
              <strong>Progress is 0%</strong>
              <p>
                Open Children, check the US/DE status and Plan Estimate. Completed is not considered
                Accepted.
              </p>
            </div>
          </article>
          <article>
            <span>06</span>
            <div>
              <strong>Unable to create Capacity Plan</strong>
              <p>
                Check for Release required, Admin and Plan rights may already exist for the same
                Project + Release.
              </p>
            </div>
          </article>
          <article>
            <span>07</span>
            <div>
              <strong>Unable to edit allocation</strong>
              <p>
                Plan is published or the account only has viewing rights. Revert to Draft using an
                authorized account.
              </p>
            </div>
          </article>
          <article>
            <span>08</span>
            <div>
              <strong>Feature disappears after removing Team</strong>
              <p>
                Check the Features and Not assigned tabs. Remove Team must keep Feature in Plan.
              </p>
            </div>
          </article>
          <article>
            <span>09</span>
            <div>
              <strong>The total number is duplicated when dividing into multiple Teams</strong>
              <p>
                Plan total only counts each allocation once; Do not add the total line of the
                Feature.
              </p>
            </div>
          </article>
        </TroubleshootList>
      </Section>
      <CheckUnderstanding>
        <strong>Check yourself before moving on to the next section</strong>
        <ul>
          <li>Do you know why Epic only appears in All Teams?</li>
          <li>You distinguish % Done by Est. with % Done by Count?</li>
          <li>Do you know that the Unit of Capacity Plan cannot be changed after creation?</li>
          <li>Have you distinguished between Unassign, Remove from Plan and Revert to Draft?</li>
        </ul>
      </CheckUnderstanding>
    </>
  )
}
