/*
 * English edition, chapter 11-quan-tri-workspace (US-119). Converted from the BA's static page
 * `public/guide/en/11-quan-tri-workspace.html`.
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
      <ChapterIntro id="chapter-11">
        <div>
          <ChapterEyebrow>PART 11 · WORKSPACE ADMINISTRATION</ChapterEyebrow>
          <h2>Manage the right people, the right Project and the right Team</h2>
          <Lead>
            <strong>Workspace Admin</strong> manage accounts in Workspace, Project structure, Teams
            and access rights. When handling, always differentiate{' '}
            <strong>Project permissions</strong> with <strong>Team member</strong>: a change in Team
            does not automatically grant or revoke Project permissions.
          </Lead>
        </div>
        <ChapterSummary aria-label="After this part you will be able to do it">
          <strong>After this chapter, you will be able to</strong>
          <ul>
            <li>Select the correct Settings page for what you need to do.</li>
            <li>Manage Users, Projects and Teams according to the correct scope.</li>
            <li>Distinguish between Admin, Editor and Workspace Admin.</li>
            <li>Read Permission Model and Audit Log.</li>
            <li>Handle cases where User is not found or permissions are incorrect.</li>
          </ul>
        </ChapterSummary>
      </ChapterIntro>
      <Section
        id="mo-quan-tri-workspace"
        number="11.1"
        title="Open the admin area"
        lead="Administrative functions are located in Settings and are divided according to the correct data type."
      >
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Open Settings</strong>
              <p>
                Select the Settings icon in the upper right corner. Group <strong>Personal</strong>{' '}
                is for personal accounts; group <strong>Workspace</strong> is for general
                administration.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Select the correct page</strong>
              <p>
                Use <strong>User Management</strong> for account;{' '}
                <strong>Workspaces & Projects</strong> for Project, Team and Project permissions;{' '}
                <strong>Permission Model</strong> to check permissions; <strong>Audit Log</strong>{' '}
                to view history.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Check permissions before editing</strong>
              <p>
                Workspace Admin can change structure. Admin and Editor only see parts that match the
                assigned Project; Admin buttons can be hidden or read-only.
              </p>
            </div>
          </li>
        </InstructionList>
        <DocTable>
          <thead>
            <tr>
              <th>Page</th>
              <th>Use when needed</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>User Management</strong>
              </td>
              <td>Find, invite and manage User status in Workspace.</td>
            </tr>
            <tr>
              <td>
                <strong>Workspaces & Projects</strong>
              </td>
              <td>Create or update Project, Project permissions, Team and Team members.</td>
            </tr>
            <tr>
              <td>
                <strong>Permission Model</strong>
              </td>
              <td>Look up the capabilities of each role. This is a read-only table.</td>
            </tr>
            <tr>
              <td>
                <strong>Audit Log</strong>
              </td>
              <td>Contrast who made which changes and when.</td>
            </tr>
          </tbody>
        </DocTable>
      </Section>
      <Section
        id="quan-ly-users"
        number="11.2"
        title="Managing Users in Workspace"
        lead="User must exist and be active in Workspace before being granted Project permissions or added to a Team."
      >
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Open User Management</strong>
              <p>
                Read User, Email, Status and Last Login columns. Use Search users, Filters or Show
                Fields when the list is long.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Invite members when needed</strong>
              <p>
                Select <strong>Invite member</strong> and enter the correct organizational account.
                Inviting a User to Workspace does not automatically grant permissions to any
                Project.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Status management</strong>
              <p>
                Only keep Users in Active state when they still need to use the system. Status
                changes affect the entire Workspace, so you must check related Projects and Teams
                before implementing.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Open Manage Access</strong>
              <p>
                Use this button to view or change the User's Project permissions. The same person
                can be Admin in one Project, Editor in another Project and have no rights in the
                remaining Project.
              </p>
            </div>
          </li>
        </InstructionList>
        <p>
          <strong>Do not use Team to replace Project permissions.</strong> Users who do not have the
          appropriate Project permissions will not be valid candidates just because you want to add
          them to the Team.
        </p>
      </Section>
      <Section
        id="quan-ly-project"
        number="11.3"
        title="Project Management"
        lead="Workspaces & Projects is the only place to manage the Workspace → Project → Team tree."
      >
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Select Project from the tree on the left</strong>
              <p>
                The Projects screen displays the Key, Project name, Status and Team number. Select a
                Project to open Details, Users & Permissions and Teams.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Create Project</strong>
              <p>
                Select <strong>Create project</strong>. Enter name and Project key; The key uses
                capital letters and numbers, is 1–10 characters long, does not overlap and does not
                change after creation.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Update Details</strong>
              <p>
                Check Status, start/end date, Project owner and Description.{' '}
                <strong>
                  Project owner is business information, does not grant Project rights itself.
                </strong>
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Estimation configuration</strong>
              <p>
                Preliminary Estimate maps XS–XL to Points; Hours per point is used by Capacity
                Planning and Reports. Only save positive values that match Project's estimation
                method.
              </p>
            </div>
          </li>
        </InstructionList>
        <p>
          <strong>Archive</strong> used when Project stops working but needs to keep history; can be
          restored from the Archive page. <strong>Delete</strong> is used when deletion is allowed
          and must go through a confirmation step. If the Project still has dependencies, the system
          may refuse to delete it.
        </p>
      </Section>
      <Section
        id="phan-quyen-project"
        number="11.4"
        title="Assign Project permissions"
        lead="Grant permissions at the Users & Permissions tab of the Project or via Manage Access of the User."
      >
        <DocTable>
          <thead>
            <tr>
              <th>Role</th>
              <th>Scope</th>
              <th>How to use</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Workspace Admin</strong>
              </td>
              <td>Complete Workspace.</td>
              <td>
                Displayed with the label Workspace Admin; There is no Access Level change dropdown
                and no Remove access button.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Admin</strong>
              </td>
              <td>One Project · All Teams.</td>
              <td>
                Managing delivery activities in Project; does not administer the Workspace
                structure.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Editor</strong>
              </td>
              <td>A Project · Team is assigned.</td>
              <td>Requires at least one active Team; Work within the assigned Team scope.</td>
            </tr>
            <tr>
              <td>
                <strong>Not assigned</strong>
              </td>
              <td>No Project scope.</td>
              <td>Project is hidden from the list and direct link is denied.</td>
            </tr>
          </tbody>
        </DocTable>
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Open Users & Permissions</strong>
              <p>
                The list displays User, Status, Access Level and Action of the currently selected
                Project.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Select Add existing user</strong>
              <p>
                Select only active Users in Workspace. This function does not create new accounts.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Select Access Level</strong>
              <p>
                Admin always has All Teams. With Editor, select at least one active Team before
                saving.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Check the scope again</strong>
              <p>
                The new permission takes effect on the next request. If the old screen has not
                changed, reload and check the context selector.
              </p>
            </div>
          </li>
        </InstructionList>
        <p>
          <strong>Workspace Admin is a system permission.</strong> They appear in the Project list
          for administrators to recognize, but do not require a separate Admin or Editor license.
        </p>
      </Section>
      <Section
        id="quan-ly-team"
        number="11.5"
        title="Team and member management"
        lead="Each Team belongs to a Project; membership determines who participates in operations in that Team."
      >
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Open the Teams tab</strong>
              <p>The list displays Key, Team, Lead, Status, number of Members and Actions.</p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Create or edit a Team</strong>
              <p>
                Team name is required. The team key is 2–10 characters long, uses capital letters
                and numbers, cannot be duplicated in the Project and does not change after the first
                save.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Add member</strong>
              <p>
                Select <strong>Add member</strong>. Candidates must be Active and qualified in
                Project: Admin, Editor assigned appropriately or Workspace Admin active.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Select Team Lead</strong>
              <p>
                Team Lead must be an Active member of the Team. This role is responsible information
                within the Team, does not create additional system rights.
              </p>
            </div>
          </li>
          <li>
            <span>5</span>
            <div>
              <strong>Deactivate when Team stops working</strong>
              <p>
                Do not assign new Work Items to inactive Teams. Check the relevant Work Item,
                Iteration and Owner before changing the status.
              </p>
            </div>
          </li>
        </InstructionList>
        <p>
          <strong>Workspace Admin is not automatically a member of every Team.</strong> They can be
          added to a Team to be Project Owner, Team Lead or Work Item Owner when qualified. Removing
          them from the Team only removes active membership, does not revoke Workspace Admin rights.
        </p>
      </Section>
      <Section
        id="doc-permission-model"
        number="11.6"
        title="Read Permission Model"
        lead="Permission Model is a fixed permission lookup table for Workspace Admin, Admin and Editor."
      >
        <p>
          Each line is a group of functions such as Backlog, Timeboxes, Quality, Portfolio, Capacity
          Planning, Reports or Settings. Values <strong>Full</strong>, <strong>view</strong>,{' '}
          <strong>edit</strong> or mark <strong>--</strong> indicates the operation level of the
          role.
        </p>
        <p>
          <strong>Unable to create custom role or edit permission matrix.</strong> When a user is
          missing an action, check their role, Project, and Team; Don't look for separate
          configuration buttons for each small permission.
        </p>
        <p>
          Part <strong>No Access</strong> explains the safe behavior: Ungranted projects are hidden
          from the list, picker, and navigation; Access using direct URL is denied.
        </p>
      </Section>
      <Section
        id="xem-audit-log"
        number="11.7"
        title="View Audit Log"
        lead="Audit Log is a reference source when you need to know whether a change has occurred or not."
      >
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Open Audit Log</strong>
              <p>
                Each line displays <strong>Time</strong>, <strong>Actor</strong> and{' '}
                <strong>Details</strong>.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Filter data</strong>
              <p>
                Use Filter this page, Filters and Show Fields to narrow the list according to the
                content being investigated.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Read Details</strong>
              <p>
                Detail describes the type of event, object and content that is easy to understand,
                for example creating a Project, renaming a Project, adding a Team member or granting
                Project permissions.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Compare scope</strong>
              <p>
                Compare Actor, time and correct Project/Team before concluding. Audit Log is
                read-only; Not used to undo changes.
              </p>
            </div>
          </li>
        </InstructionList>
      </Section>
      <Section
        id="xu-ly-quan-tri"
        number="11.8"
        title="Troubleshooting"
        lead="Check the order of Workspace account → Project permissions → Team membership."
      >
        <TroubleshootList>
          <article>
            <span>01</span>
            <div>
              <strong>User not found when Add existing user</strong>
              <p>
                Check that the User is already in the Workspace, is Active and has not been granted
                Project rights.
              </p>
            </div>
          </article>
          <article>
            <span>02</span>
            <div>
              <strong>Editor has no Team to choose from</strong>
              <p>
                Create or activate a Team first. Editor needs at least one Active Team in the
                Project.
              </p>
            </div>
          </article>
          <article>
            <span>03</span>
            <div>
              <strong>Added to Team but still can't access Project</strong>
              <p>
                Team membership does not grant Project Access. Go back to Users & Permissions and
                level Admin or Editor accordingly.
              </p>
            </div>
          </article>
          <article>
            <span>05</span>
            <div>
              <strong>Cannot change or delete the Workspace Admin line</strong>
              <p>
                This is a system permission line, used only for identification. Do not grant
                additional Admin/Editor to the same Project.
              </p>
            </div>
          </article>
          <article>
            <span>06</span>
            <div>
              <strong>Workspace Admin does not appear in Owner</strong>
              <p>
                Add them as Active members of the currently selected Team. Workspace Admin rights
                allow creating US/DE but do not make the name appear in the Owner list.
              </p>
            </div>
          </article>
          <article>
            <span>07</span>
            <div>
              <strong>Project owner does not have management rights</strong>
              <p>
                Project owner is metadata. Grant a separate Admin or Editor if that person needs to
                access the system.
              </p>
            </div>
          </article>
          <article>
            <span>08</span>
            <div>
              <strong>
                Permissions have just been changed but the interface has not been updated
              </strong>
              <p>
                Reload the page, check for the next request and select Project/Team again in the
                context selector.
              </p>
            </div>
          </article>
          <article>
            <span>09</span>
            <div>
              <strong>Cannot Archive or Delete Project</strong>
              <p>
                Read dependency messages and assertion steps. Use Archive when you need to preserve
                history and Delete only when the data is actually allowed to be deleted.
              </p>
            </div>
          </article>
        </TroubleshootList>
      </Section>
      <CheckUnderstanding>
        <strong>Check yourself before moving on to the next section</strong>
        <ul>
          <li>Have you distinguished between Project and Team member rights?</li>
          <li>Do you know that Admin and Editor are different in Team scope?</li>
          <li>Do you know why Workspace Admin doesn't have a button to change Access Level?</li>
          <li>Do you know how to use Audit Log to compare changes?</li>
        </ul>
      </CheckUnderstanding>
    </>
  )
}
