/*
 * English edition, chapter 02-truy-cap-pham-vi (US-119). Converted from the BA's static page
 * `public/guide/en/02-truy-cap-pham-vi.html`.
 */
import { GuideShot } from '../../ui/guide-shot'
import {
  Callout,
  ChapterEyebrow,
  ChapterIntro,
  ChapterSummary,
  DocTable,
  HomeSections,
  InstructionList,
  Lead,
  NavigationLegend,
  PersonalToolsGrid,
  ResultBox,
  Section,
  TaskPrereq,
  ToolIcon,
  TroubleshootList,
} from '../../ui/parts'

export default function Chapter() {
  return (
    <>
      <ChapterIntro id="chapter-02">
        <div>
          <ChapterEyebrow>SECTION 02 · ACCESS & SCOPE</ChapterEyebrow>
          <h2>Go to the right place before starting work</h2>
          <Lead>
            Logging in just takes you into Rova. Before viewing or updating data, confirm it is
            correct <strong>Project</strong> and <strong>Team</strong> on the top bar.
          </Lead>
        </div>
        <ChapterSummary aria-label="After this part you will be able to do it">
          <strong>After this chapter, you will be able to</strong>
          <ul>
            <li>Log in using the method provided by your organization.</li>
            <li>Identify key areas on the navigation bar.</li>
            <li>Switch Project/Team and check the current scope.</li>
            <li>Find Work Item, view notifications and open personal account.</li>
            <li>Know what to check when you don't see Project or Team.</li>
          </ul>
        </ChapterSummary>
      </ChapterIntro>
      <Section
        id="dang-nhap"
        number="02.1"
        title="Log in to Rova"
        lead="Use an already enabled organizational account. No need to ask for additional permissions just to open the login page."
      >
        <TaskPrereq>
          <span>BEFORE STARTING</span> <strong>You need it</strong>
          <ul>
            <li>Organization email is active.</li>
            <li>Permission to access at least one Project if you need to work in Project.</li>
          </ul>
        </TaskPrereq>
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Open the Rova page</strong>
              <p>
                Access the address provided by the organization. The login page displays the field{' '}
                <b>Email address</b>.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Choose a login method</strong>
              <p>
                Enter email and select <b>Continue</b>, or select <b>Sign in with Microsoft</b> if
                your organization uses Microsoft.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Authentication completed</strong>
              <p>
                Follow the organization authentication screen. Do not share your password or
                authentication code with others.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Check the results</strong>
              <p>
                On success, Rova opens the page <b>Home</b>; Your name or profile picture appears in
                the upper right corner.
              </p>
            </div>
          </li>
        </InstructionList>
        <Callout>
          <strong>Don't have access yet?</strong>
          <p>
            Select link <b>Contact your administrator</b> on the login page or contact your
            organization's Workspace Admin. Do not use another account to bypass authorization.
          </p>
        </Callout>
      </Section>
      <Section
        id="thanh-dieu-huong"
        number="02.2"
        title="Read the navigation bar"
        lead="The header bar holds the main entry points. The menu displayed may vary according to your rights and scope."
      >
        <GuideShot
          name="02-top-navigation-annotated"
          alt="Rova navigation bar with four numbered locations: scope selector, business menu, search box, and personal tools."
          caption="Rova navigation bar. The numbers correspond to the explanation below."
        />
        <NavigationLegend>
          <article>
            <span>1</span>
            <div>
              <strong>Context selector</strong>
              <p>Indicates Workspace, Project and Team are selected; Used to change scope.</p>
            </div>
          </article>
          <article>
            <span>2</span>
            <div>
              <strong>Business menu</strong>
              <p>
                <b>Plan</b>, <b>Track</b>, <b>Quality</b> and <b>Portfolio</b> open function groups;{' '}
                <b>Home</b> and <b>Reports</b> is the direct link.
              </p>
            </div>
          </article>
          <article>
            <span>3</span>
            <div>
              <strong>Quick search</strong>
              <p>Find Work Item from the top bar and open the appropriate result directly.</p>
            </div>
          </article>
          <article>
            <span>4</span>
            <div>
              <strong>Personal tools</strong>
              <p>Opens notifications, help, Settings and account menus.</p>
            </div>
          </article>
        </NavigationLegend>
      </Section>
      <Section
        id="chon-project-team"
        number="02.3"
        title="Select the correct Project and Team"
        lead="This is a step that needs to be repeated every time you switch to a different product or group."
      >
        <GuideShot
          name="02-context-selector-production"
          alt="Context selector Rova, displaying Workspace QNSC, Project Knowledge Base, All Teams and Team OnlyS."
          caption="Context selector is used to select Workspace, Project and Team."
          narrow
        />
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Open context selector</strong>
              <p>
                Select Workspace display area and line <b>Project · Team</b> in the upper left
                corner.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Select Project</strong>
              <p>
                The list only displays Projects you are allowed to access. Open the Project you need
                to work on to see available Teams.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Select Team or All Teams</strong>
              <p>
                Select a specific Team when working with that team. <b>All Teams</b> is an Admin
                view scope, not a Team to assign to Work Item.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Check the title again</strong>
              <p>
                After choosing, Rova takes you home <b>Home</b>. Confirm the line{' '}
                <b>Project · Team</b> changed before continuing.
              </p>
            </div>
          </li>
        </InstructionList>
        <ResultBox>
          <span>EXPECTED RESULTS</span> <strong>Home opens in the new scope</strong>
          <p>
            Data by Project/Team is reloaded. Content from the previous scope is not retained as
            current data.
          </p>
        </ResultBox>
        <Callout tone="warning">
          <strong>Changing Team can cause the Owner list to change</strong>
          <p>
            Who can be selected as Owner depending on Project, Team, rights and valid membership.
            Please choose the correct Team before creating US or Defect.
          </p>
        </Callout>
      </Section>
      <Section
        id="doc-trang-home"
        number="02.4"
        title="Read the Home page"
        lead="Home is a quick checkpoint after logging in or changing scope."
      >
        <DocTable columns="metrics">
          <thead>
            <tr>
              <th>Index</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Active Projects</strong>
              </td>
              <td>Number of active Projects that your account is allowed to view.</td>
            </tr>
            <tr>
              <td>
                <strong>Open Work Items</strong>
              </td>
              <td>Number of unfinished Work Items within the currently displayed data scope.</td>
            </tr>
            <tr>
              <td>
                <strong>Active Sprints</strong>
              </td>
              <td>Number of active duty cycles.</td>
            </tr>
            <tr>
              <td>
                <strong>Blocked Items</strong>
              </td>
              <td>
                Number of Work Items in status <b>Blocked</b>.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Open Defects</strong>
              </td>
              <td>Defect number has not completed processing.</td>
            </tr>
            <tr>
              <td>
                <strong>Assigned to Me</strong>
              </td>
              <td>Number of Work Items being assigned to your account.</td>
            </tr>
          </tbody>
        </DocTable>
        <HomeSections>
          <article>
            <strong>My Work</strong>
            <p>
              Work Items assigned to you. Select <b>All</b> to open the full list.
            </p>
          </article>
          <article>
            <strong>Recent Activity</strong>
            <p>Recent activity your account is allowed to see.</p>
          </article>
          <article>
            <strong>Project Health</strong>
            <p>Overview Project, Iteration is running, progress and bugs are open.</p>
          </article>
        </HomeSections>
        <Callout>
          <strong>Do not use a single metric to confirm the scope</strong>
          <p>
            Please read the context selector and breadcrumb first. Some Home tabs may aggregate
            broader data than Team is choosing at your discretion.
          </p>
        </Callout>
      </Section>
      <Section
        id="cong-cu-ca-nhan"
        number="02.5"
        title="Search, notifications, and accounts"
        lead="These three tools are always located on the top bar and serve logged in users."
      >
        <PersonalToolsGrid>
          <article>
            <ToolIcon>⌕</ToolIcon>
            <h3>Search work items</h3>
            <ol>
              <li>Enter the Work Item name ID or keyword.</li>
              <li>Read the ID and title in the suggestion list.</li>
              <li>Select the result to open the details page.</li>
            </ol>
          </article>
          <article>
            <ToolIcon>◎</ToolIcon>
            <h3>Notifications</h3>
            <ol>
              <li>Select the bell icon.</li>
              <li>
                Use <b>Unread only</b> when you only want to view unread items.
              </li>
              <li>
                Select <b>View all</b> to open the Notifications page.
              </li>
            </ol>
          </article>
          <article>
            <ToolIcon>HV</ToolIcon>
            <h3>Personal account</h3>
            <ol>
              <li>Select name or avatar.</li>
              <li>
                Open <b>My profile</b> or <b>Settings</b> when needed.
              </li>
              <li>
                Select <b>Sign out</b> to end the session.
              </li>
            </ol>
          </article>
        </PersonalToolsGrid>
      </Section>
      <Section
        id="xu-ly-truy-cap"
        number="02.6"
        title="Handling when Project or Team is not visible"
        lead="Check in the order below before concluding that data is lost."
      >
        <TroubleshootList>
          <article>
            <span>01</span>
            <div>
              <strong>Project not found</strong>
              <p>
                Open the context selector again and check the correct Workspace. If Project still
                does not appear, ask Workspace Admin to check the account's Project Access.
              </p>
            </div>
          </article>
          <article>
            <span>02</span>
            <div>
              <strong>See Project but not Team</strong>
              <p>
                Admin works at <b>All Teams</b>. The Editor only sees the assigned Team; Ask
                Workspace Admin to check Team membership.
              </p>
            </div>
          </article>
          <article>
            <span>03</span>
            <div>
              <strong>Direct path denied</strong>
              <p>
                Return to Home, select a Project/Team you are allowed to access and then reopen the
                function from the menu. If you still need that data, contact Workspace Admin.
              </p>
            </div>
          </article>
          <article>
            <span>05</span>
            <div>
              <strong>The page still shows the old scope</strong>
              <p>
                Read the context selector again, wait for the data to finish loading, and refresh
                the page once. Do not update the Work Item until the scope header is correct.
              </p>
            </div>
          </article>
        </TroubleshootList>
        <ResultBox tone="support">
          <span>WHEN CONTACT SUPPORT</span> <strong>Send all three information</strong>
          <p>
            Account email, Project/Team name to access and screenshot of context selector or message
            being displayed. Do not send passwords or authentication codes.
          </p>
        </ResultBox>
      </Section>
    </>
  )
}
