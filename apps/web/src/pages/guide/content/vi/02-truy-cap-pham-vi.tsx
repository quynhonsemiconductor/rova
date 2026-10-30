/*
 * Vietnamese edition, chapter 02-truy-cap-pham-vi (US-119). Converted from the BA's static page
 * `public/guide/02-truy-cap-pham-vi.html`.
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
          <ChapterEyebrow>PHẦN 02 · TRUY CẬP & PHẠM VI</ChapterEyebrow>
          <h2>Vào đúng nơi trước khi bắt đầu công việc</h2>
          <Lead>
            Đăng nhập chỉ đưa bạn vào Rova. Trước khi xem hoặc cập nhật dữ liệu, hãy xác nhận đúng{' '}
            <strong>Project</strong> và <strong>Team</strong> trên thanh đầu trang.
          </Lead>
        </div>
        <ChapterSummary aria-label="Sau phần này bạn sẽ làm được">
          <strong>Sau phần này, bạn sẽ làm được</strong>
          <ul>
            <li>Đăng nhập bằng phương thức tổ chức cung cấp.</li>
            <li>Nhận biết các khu vực chính trên thanh điều hướng.</li>
            <li>Chuyển Project/Team và kiểm tra phạm vi hiện tại.</li>
            <li>Tìm Work Item, xem thông báo và mở tài khoản cá nhân.</li>
            <li>Biết cần kiểm tra gì khi không thấy Project hoặc Team.</li>
          </ul>
        </ChapterSummary>
      </ChapterIntro>
      <Section
        id="dang-nhap"
        number="02.1"
        title="Đăng nhập vào Rova"
        lead="Dùng tài khoản tổ chức đã được kích hoạt. Không cần xin thêm quyền chỉ để mở trang đăng nhập."
      >
        <TaskPrereq>
          <span>TRƯỚC KHI BẮT ĐẦU</span> <strong>Bạn cần có</strong>
          <ul>
            <li>Email tổ chức đang hoạt động.</li>
            <li>Quyền truy cập ít nhất một Project nếu cần làm việc trong Project.</li>
          </ul>
        </TaskPrereq>
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Mở trang Rova</strong>
              <p>
                Truy cập địa chỉ do tổ chức cung cấp. Trang đăng nhập hiển thị trường{' '}
                <b>Email address</b>.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Chọn cách đăng nhập</strong>
              <p>
                Nhập email rồi chọn <b>Continue</b>, hoặc chọn <b>Sign in with Microsoft</b> nếu tổ
                chức của bạn dùng Microsoft.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Hoàn tất xác thực</strong>
              <p>
                Làm theo màn hình xác thực của tổ chức. Không chia sẻ mật khẩu hoặc mã xác thực cho
                người khác.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Kiểm tra kết quả</strong>
              <p>
                Khi thành công, Rova mở trang <b>Home</b>; tên hoặc ảnh đại diện của bạn xuất hiện ở
                góc trên bên phải.
              </p>
            </div>
          </li>
        </InstructionList>
        <Callout>
          <strong>Chưa có quyền truy cập?</strong>
          <p>
            Chọn liên kết <b>Contact your administrator</b> trên trang đăng nhập hoặc liên hệ
            Workspace Admin của tổ chức. Không tự dùng tài khoản khác để bỏ qua phân quyền.
          </p>
        </Callout>
      </Section>
      <Section
        id="thanh-dieu-huong"
        number="02.2"
        title="Đọc thanh điều hướng"
        lead="Thanh đầu trang giữ các điểm vào chính. Menu hiển thị có thể khác theo quyền và phạm vi của bạn."
      >
        <GuideShot
          name="02-top-navigation-annotated"
          alt="Thanh điều hướng Rova với bốn vị trí được đánh số: bộ chọn phạm vi, menu nghiệp vụ, ô tìm kiếm và công cụ cá nhân."
          caption="Thanh điều hướng Rova. Các số tương ứng với phần giải thích bên dưới."
        />
        <NavigationLegend>
          <article>
            <span>1</span>
            <div>
              <strong>Context selector</strong>
              <p>Cho biết Workspace, Project và Team đang chọn; dùng để đổi phạm vi.</p>
            </div>
          </article>
          <article>
            <span>2</span>
            <div>
              <strong>Menu nghiệp vụ</strong>
              <p>
                <b>Plan</b>, <b>Track</b>, <b>Quality</b> và <b>Portfolio</b> mở các nhóm chức năng;{' '}
                <b>Home</b> và <b>Reports</b> là liên kết trực tiếp.
              </p>
            </div>
          </article>
          <article>
            <span>3</span>
            <div>
              <strong>Tìm kiếm nhanh</strong>
              <p>Tìm Work Item từ thanh đầu trang và mở thẳng kết quả phù hợp.</p>
            </div>
          </article>
          <article>
            <span>4</span>
            <div>
              <strong>Công cụ cá nhân</strong>
              <p>Mở thông báo, trợ giúp, Settings và menu tài khoản.</p>
            </div>
          </article>
        </NavigationLegend>
      </Section>
      <Section
        id="chon-project-team"
        number="02.3"
        title="Chọn đúng Project và Team"
        lead="Đây là bước cần làm lại mỗi khi bạn chuyển sang sản phẩm hoặc nhóm khác."
      >
        <GuideShot
          name="02-context-selector-production"
          alt="Context selector Rova, hiển thị Workspace QNSC, Project Knowledge Base, All Teams và Team OnlyS."
          caption="Context selector dùng để chọn Workspace, Project và Team."
          narrow
        />
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Mở context selector</strong>
              <p>
                Chọn khu vực hiển thị Workspace và dòng <b>Project · Team</b> ở góc trên bên trái.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Chọn Project</strong>
              <p>
                Danh sách chỉ hiển thị Project bạn được phép truy cập. Mở Project cần làm việc để
                xem các Team có sẵn.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Chọn Team hoặc All Teams</strong>
              <p>
                Chọn Team cụ thể khi làm việc với nhóm đó. <b>All Teams</b> là phạm vi xem của
                Admin, không phải một Team để gán cho Work Item.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Kiểm tra lại tiêu đề</strong>
              <p>
                Sau khi chọn, Rova đưa bạn về <b>Home</b>. Xác nhận dòng <b>Project · Team</b> đã
                đổi trước khi tiếp tục.
              </p>
            </div>
          </li>
        </InstructionList>
        <ResultBox>
          <span>KẾT QUẢ MONG ĐỢI</span> <strong>Home mở trong phạm vi mới</strong>
          <p>
            Dữ liệu theo Project/Team được tải lại. Nội dung từ phạm vi trước không được giữ lại như
            dữ liệu hiện tại.
          </p>
        </ResultBox>
        <Callout tone="warning">
          <strong>Đổi Team có thể làm danh sách Owner thay đổi</strong>
          <p>
            Người có thể được chọn làm Owner phụ thuộc Project, Team, quyền và membership hợp lệ.
            Hãy chọn đúng Team trước khi tạo US hoặc Defect.
          </p>
        </Callout>
      </Section>
      <Section
        id="doc-trang-home"
        number="02.4"
        title="Đọc trang Home"
        lead="Home là điểm kiểm tra nhanh sau khi đăng nhập hoặc đổi phạm vi."
      >
        <DocTable columns="metrics">
          <thead>
            <tr>
              <th>Chỉ số</th>
              <th>Mô tả</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Active Projects</strong>
              </td>
              <td>Số Project đang hoạt động mà tài khoản của bạn được phép xem.</td>
            </tr>
            <tr>
              <td>
                <strong>Open Work Items</strong>
              </td>
              <td>Số Work Item chưa hoàn tất trong phạm vi dữ liệu đang hiển thị.</td>
            </tr>
            <tr>
              <td>
                <strong>Active Sprints</strong>
              </td>
              <td>Số chu kỳ làm việc đang hoạt động.</td>
            </tr>
            <tr>
              <td>
                <strong>Blocked Items</strong>
              </td>
              <td>
                Số Work Item đang ở trạng thái <b>Blocked</b>.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Open Defects</strong>
              </td>
              <td>Số Defect chưa hoàn tất xử lý.</td>
            </tr>
            <tr>
              <td>
                <strong>Assigned to Me</strong>
              </td>
              <td>Số Work Item đang được giao cho tài khoản của bạn.</td>
            </tr>
          </tbody>
        </DocTable>
        <HomeSections>
          <article>
            <strong>My Work</strong>
            <p>
              Công việc đang gán cho bạn. Chọn <b>All</b> để mở danh sách đầy đủ.
            </p>
          </article>
          <article>
            <strong>Recent Activity</strong>
            <p>Hoạt động gần đây mà tài khoản của bạn được phép xem.</p>
          </article>
          <article>
            <strong>Project Health</strong>
            <p>Tổng quan Project, Iteration đang chạy, tiến độ và lỗi đang mở.</p>
          </article>
        </HomeSections>
        <Callout>
          <strong>Đừng dùng một con số để xác nhận phạm vi</strong>
          <p>
            Hãy đọc context selector và breadcrumb trước. Một số thẻ Home có thể tổng hợp dữ liệu
            rộng hơn Team đang chọn tùy quyền của bạn.
          </p>
        </Callout>
      </Section>
      <Section
        id="cong-cu-ca-nhan"
        number="02.5"
        title="Tìm kiếm, thông báo và tài khoản"
        lead="Ba công cụ này luôn nằm trên thanh đầu trang và phục vụ người dùng đang đăng nhập."
      >
        <PersonalToolsGrid>
          <article>
            <ToolIcon>⌕</ToolIcon>
            <h3>Search work items</h3>
            <ol>
              <li>Nhập ID hoặc từ khóa tên Work Item.</li>
              <li>Đọc ID và tiêu đề trong danh sách gợi ý.</li>
              <li>Chọn kết quả để mở trang chi tiết.</li>
            </ol>
          </article>
          <article>
            <ToolIcon>◎</ToolIcon>
            <h3>Notifications</h3>
            <ol>
              <li>Chọn biểu tượng chuông.</li>
              <li>
                Dùng <b>Unread only</b> khi chỉ muốn xem mục chưa đọc.
              </li>
              <li>
                Chọn <b>View all</b> để mở trang Notifications.
              </li>
            </ol>
          </article>
          <article>
            <ToolIcon>HV</ToolIcon>
            <h3>Tài khoản cá nhân</h3>
            <ol>
              <li>Chọn tên hoặc ảnh đại diện.</li>
              <li>
                Mở <b>My profile</b> hoặc <b>Settings</b> khi cần.
              </li>
              <li>
                Chọn <b>Sign out</b> để kết thúc phiên làm việc.
              </li>
            </ol>
          </article>
        </PersonalToolsGrid>
      </Section>
      <Section
        id="xu-ly-truy-cap"
        number="02.6"
        title="Xử lý khi không thấy Project hoặc Team"
        lead="Kiểm tra theo thứ tự dưới đây trước khi kết luận dữ liệu bị mất."
      >
        <TroubleshootList>
          <article>
            <span>01</span>
            <div>
              <strong>Không thấy Project</strong>
              <p>
                Mở lại context selector và kiểm tra đúng Workspace. Nếu Project vẫn không xuất hiện,
                nhờ Workspace Admin kiểm tra Project Access của tài khoản.
              </p>
            </div>
          </article>
          <article>
            <span>02</span>
            <div>
              <strong>Thấy Project nhưng không thấy Team</strong>
              <p>
                Admin làm việc ở <b>All Teams</b>. Editor chỉ thấy Team được gán; nhờ Workspace
                Admin kiểm tra Team membership.
              </p>
            </div>
          </article>
          <article>
            <span>03</span>
            <div>
              <strong>Đường dẫn trực tiếp bị từ chối</strong>
              <p>
                Quay về Home, chọn một Project/Team bạn được phép truy cập rồi mở lại chức năng từ
                menu. Nếu vẫn cần dữ liệu đó, liên hệ Workspace Admin.
              </p>
            </div>
          </article>
          <article>
            <span>05</span>
            <div>
              <strong>Trang còn hiển thị phạm vi cũ</strong>
              <p>
                Đọc lại context selector, chờ dữ liệu tải xong và làm mới trang một lần. Không cập
                nhật Work Item cho đến khi tiêu đề phạm vi đã đúng.
              </p>
            </div>
          </article>
        </TroubleshootList>
        <ResultBox tone="support">
          <span>KHI LIÊN HỆ HỖ TRỢ</span> <strong>Gửi đủ ba thông tin</strong>
          <p>
            Email tài khoản, tên Project/Team cần truy cập và ảnh chụp context selector hoặc thông
            báo đang thấy. Không gửi mật khẩu hoặc mã xác thực.
          </p>
        </ResultBox>
      </Section>
    </>
  )
}
