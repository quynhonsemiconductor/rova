/*
 * Vietnamese edition, chapter 11-quan-tri-workspace (US-119). Converted from the BA's static page
 * `public/guide/11-quan-tri-workspace.html`.
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
          <ChapterEyebrow>PHẦN 11 · QUẢN TRỊ WORKSPACE</ChapterEyebrow>
          <h2>Quản lý đúng người, đúng Project và đúng Team</h2>
          <Lead>
            <strong>Workspace Admin</strong> quản lý tài khoản trong Workspace, cấu trúc Project,
            Team và quyền truy cập. Khi thao tác, luôn phân biệt <strong>quyền Project</strong> với{' '}
            <strong>thành viên Team</strong>: một thay đổi ở Team không tự cấp hoặc thu hồi quyền
            Project.
          </Lead>
        </div>
        <ChapterSummary aria-label="Sau phần này bạn sẽ làm được">
          <strong>Sau phần này, bạn sẽ làm được</strong>
          <ul>
            <li>Chọn đúng trang Settings cho việc cần làm.</li>
            <li>Quản lý User, Project và Team theo đúng phạm vi.</li>
            <li>Phân biệt Admin, Editor và Workspace Admin.</li>
            <li>Đọc Permission Model và Audit Log.</li>
            <li>Xử lý các trường hợp không thấy User hoặc quyền chưa đúng.</li>
          </ul>
        </ChapterSummary>
      </ChapterIntro>
      <Section
        id="mo-quan-tri-workspace"
        number="11.1"
        title="Mở khu vực quản trị"
        lead="Các chức năng quản trị nằm trong Settings và được chia theo đúng loại dữ liệu."
      >
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Mở Settings</strong>
              <p>
                Chọn biểu tượng Settings ở góc trên bên phải. Nhóm <strong>Personal</strong> dùng
                cho tài khoản cá nhân; nhóm <strong>Workspace</strong> dùng cho quản trị chung.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Chọn đúng trang</strong>
              <p>
                Dùng <strong>User Management</strong> cho tài khoản;{' '}
                <strong>Workspaces & Projects</strong> cho Project, Team và quyền Project;{' '}
                <strong>Permission Model</strong> để tra quyền; <strong>Audit Log</strong> để xem
                lịch sử.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Kiểm tra quyền trước khi sửa</strong>
              <p>
                Workspace Admin có thể thay đổi cấu trúc. Admin và Editor chỉ thấy phần phù hợp với
                Project được cấp; các nút quản trị có thể bị ẩn hoặc chỉ đọc.
              </p>
            </div>
          </li>
        </InstructionList>
        <DocTable>
          <thead>
            <tr>
              <th>Trang</th>
              <th>Dùng khi cần</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>User Management</strong>
              </td>
              <td>Tìm, mời và quản lý trạng thái User trong Workspace.</td>
            </tr>
            <tr>
              <td>
                <strong>Workspaces & Projects</strong>
              </td>
              <td>Tạo hoặc cập nhật Project, quyền Project, Team và thành viên Team.</td>
            </tr>
            <tr>
              <td>
                <strong>Permission Model</strong>
              </td>
              <td>Tra khả năng của từng vai trò. Đây là bảng chỉ đọc.</td>
            </tr>
            <tr>
              <td>
                <strong>Audit Log</strong>
              </td>
              <td>Đối chiếu ai đã thực hiện thay đổi nào và vào thời điểm nào.</td>
            </tr>
          </tbody>
        </DocTable>
      </Section>
      <Section
        id="quan-ly-users"
        number="11.2"
        title="Quản lý User trong Workspace"
        lead="User phải tồn tại và đang hoạt động trong Workspace trước khi được cấp quyền Project hoặc thêm vào Team."
      >
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Mở User Management</strong>
              <p>
                Đọc các cột User, Email, Status và Last Login. Dùng Search users, Filters hoặc Show
                Fields khi danh sách dài.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Mời thành viên khi cần</strong>
              <p>
                Chọn <strong>Invite member</strong> và nhập đúng tài khoản tổ chức. Việc mời User
                vào Workspace chưa tự cấp quyền cho bất kỳ Project nào.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Quản lý trạng thái</strong>
              <p>
                Chỉ giữ User ở trạng thái Active khi họ còn cần sử dụng hệ thống. Thay đổi trạng
                thái ảnh hưởng toàn Workspace, vì vậy phải kiểm tra các Project và Team liên quan
                trước khi thực hiện.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Mở Manage Access</strong>
              <p>
                Dùng nút này để xem hoặc thay đổi quyền Project của User. Cùng một người có thể là
                Admin ở Project này, Editor ở Project khác và không có quyền ở Project còn lại.
              </p>
            </div>
          </li>
        </InstructionList>
        <p>
          <strong>Không dùng Team để thay thế quyền Project.</strong> User chưa có quyền Project phù
          hợp sẽ không trở thành ứng viên hợp lệ chỉ vì bạn muốn thêm họ vào Team.
        </p>
      </Section>
      <Section
        id="quan-ly-project"
        number="11.3"
        title="Quản lý Project"
        lead="Workspaces & Projects là nơi duy nhất quản lý cây Workspace → Project → Team."
      >
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Chọn Project từ cây bên trái</strong>
              <p>
                Màn hình Projects hiển thị Key, tên Project, Status và số Team. Chọn một Project để
                mở Details, Users & Permissions và Teams.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Tạo Project</strong>
              <p>
                Chọn <strong>Create project</strong>. Nhập tên và Project key; key dùng chữ in hoa
                và số, dài 1–10 ký tự, không trùng và không đổi sau khi tạo.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Cập nhật Details</strong>
              <p>
                Kiểm tra Status, ngày bắt đầu/kết thúc, Project owner và Description.{' '}
                <strong>Project owner là thông tin nghiệp vụ, không tự cấp quyền Project.</strong>
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Cấu hình Estimation</strong>
              <p>
                Preliminary Estimate ánh xạ XS–XL sang Points; Hours per point được Capacity
                Planning và Reports sử dụng. Chỉ lưu giá trị dương phù hợp với cách ước lượng của
                Project.
              </p>
            </div>
          </li>
        </InstructionList>
        <p>
          <strong>Archive</strong> dùng khi Project ngừng hoạt động nhưng cần giữ lịch sử; có thể
          khôi phục từ trang Archive. <strong>Delete</strong> dùng khi được phép xóa hẳn và phải qua
          bước xác nhận. Nếu Project còn phụ thuộc, hệ thống có thể từ chối xóa.
        </p>
      </Section>
      <Section
        id="phan-quyen-project"
        number="11.4"
        title="Phân quyền Project"
        lead="Cấp quyền tại tab Users & Permissions của Project hoặc qua Manage Access của User."
      >
        <DocTable>
          <thead>
            <tr>
              <th>Vai trò</th>
              <th>Phạm vi</th>
              <th>Cách dùng</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Workspace Admin</strong>
              </td>
              <td>Toàn Workspace.</td>
              <td>
                Được hiển thị bằng nhãn Workspace Admin; không có dropdown đổi Access Level và không
                có nút Remove access.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Admin</strong>
              </td>
              <td>Một Project · All Teams.</td>
              <td>Quản lý hoạt động delivery trong Project; không quản trị cấu trúc Workspace.</td>
            </tr>
            <tr>
              <td>
                <strong>Editor</strong>
              </td>
              <td>Một Project · Team được gán.</td>
              <td>Cần ít nhất một Team đang hoạt động; làm việc trong phạm vi Team được cấp.</td>
            </tr>
            <tr>
              <td>
                <strong>Không được gán</strong>
              </td>
              <td>Không có phạm vi Project.</td>
              <td>Project bị ẩn khỏi danh sách và đường dẫn trực tiếp bị từ chối.</td>
            </tr>
          </tbody>
        </DocTable>
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Mở Users & Permissions</strong>
              <p>Danh sách hiển thị User, Status, Access Level và Action của Project đang chọn.</p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Chọn Add existing user</strong>
              <p>
                Chỉ chọn User đang hoạt động trong Workspace. Chức năng này không tạo tài khoản mới.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Chọn Access Level</strong>
              <p>
                Admin luôn có All Teams. Với Editor, chọn ít nhất một Team đang hoạt động trước khi
                lưu.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Kiểm tra lại phạm vi</strong>
              <p>
                Quyền mới có hiệu lực ở request tiếp theo. Nếu màn hình cũ chưa đổi, tải lại và kiểm
                tra context selector.
              </p>
            </div>
          </li>
        </InstructionList>
        <p>
          <strong>Workspace Admin là quyền hệ thống.</strong> Họ xuất hiện trong danh sách Project
          để người quản trị nhận biết, nhưng không cần một bản cấp quyền Admin hoặc Editor riêng.
        </p>
      </Section>
      <Section
        id="quan-ly-team"
        number="11.5"
        title="Quản lý Team và thành viên"
        lead="Mỗi Team thuộc một Project; membership xác định ai tham gia vận hành trong Team đó."
      >
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Mở tab Teams</strong>
              <p>Danh sách hiển thị Key, Team, Lead, Status, số Members và Actions.</p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Tạo hoặc sửa Team</strong>
              <p>
                Tên Team là bắt buộc. Team key dài 2–10 ký tự, dùng chữ in hoa và số, không trùng
                trong Project và không đổi sau lần lưu đầu.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Thêm thành viên</strong>
              <p>
                Chọn <strong>Add member</strong>. Ứng viên phải Active và đủ điều kiện trong
                Project: Admin, Editor đã được gán phù hợp hoặc Workspace Admin đang hoạt động.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Chọn Team Lead</strong>
              <p>
                Team Lead phải là thành viên Active của Team. Vai trò này là thông tin chịu trách
                nhiệm trong Team, không tạo thêm quyền hệ thống.
              </p>
            </div>
          </li>
          <li>
            <span>5</span>
            <div>
              <strong>Deactivate khi Team ngừng hoạt động</strong>
              <p>
                Không gán công việc mới vào Team đã dừng. Kiểm tra Work Item, Iteration và Owner
                liên quan trước khi đổi trạng thái.
              </p>
            </div>
          </li>
        </InstructionList>
        <p>
          <strong>Workspace Admin không tự động là thành viên mọi Team.</strong> Có thể thêm họ vào
          một Team để làm Project Owner, Team Lead hoặc Work Item Owner khi đủ điều kiện. Xóa họ
          khỏi Team chỉ bỏ membership vận hành, không thu hồi quyền Workspace Admin.
        </p>
      </Section>
      <Section
        id="doc-permission-model"
        number="11.6"
        title="Đọc Permission Model"
        lead="Permission Model là bảng tra cứu quyền cố định cho Workspace Admin, Admin và Editor."
      >
        <p>
          Mỗi dòng là một nhóm chức năng như Backlog, Timeboxes, Quality, Portfolio, Capacity
          Planning, Reports hoặc Settings. Các giá trị <strong>Full</strong>, <strong>view</strong>,{' '}
          <strong>edit</strong> hay dấu <strong>--</strong> cho biết mức thao tác của vai trò.
        </p>
        <p>
          <strong>Không thể tạo custom role hoặc sửa ma trận quyền.</strong> Khi người dùng thiếu
          một thao tác, hãy kiểm tra role, Project và Team của họ; không tìm nút cấu hình riêng cho
          từng quyền nhỏ.
        </p>
        <p>
          Phần <strong>No Access</strong> giải thích hành vi an toàn: Project không được cấp sẽ bị
          ẩn khỏi danh sách, picker và điều hướng; truy cập bằng URL trực tiếp bị từ chối.
        </p>
      </Section>
      <Section
        id="xem-audit-log"
        number="11.7"
        title="Xem Audit Log"
        lead="Audit Log là nguồn đối chiếu khi cần biết một thay đổi đã diễn ra hay chưa."
      >
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Mở Audit Log</strong>
              <p>
                Mỗi dòng hiển thị <strong>Time</strong>, <strong>Actor</strong> và{' '}
                <strong>Detail</strong>.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Lọc dữ liệu</strong>
              <p>
                Dùng Filter this page, Filters và Show Fields để thu hẹp danh sách theo nội dung
                đang điều tra.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Đọc Detail</strong>
              <p>
                Detail mô tả loại sự kiện, đối tượng và nội dung dễ hiểu, ví dụ tạo Project, đổi tên
                Project, thêm thành viên Team hoặc cấp quyền Project.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Đối chiếu phạm vi</strong>
              <p>
                So sánh Actor, thời gian và đúng Project/Team trước khi kết luận. Audit Log chỉ đọc;
                không dùng để hoàn tác thay đổi.
              </p>
            </div>
          </li>
        </InstructionList>
      </Section>
      <Section
        id="xu-ly-quan-tri"
        number="11.8"
        title="Xử lý tình huống thường gặp"
        lead="Kiểm tra theo thứ tự tài khoản Workspace → quyền Project → membership Team."
      >
        <TroubleshootList>
          <article>
            <span>01</span>
            <div>
              <strong>Không thấy User khi Add existing user</strong>
              <p>
                Kiểm tra User đã có trong Workspace, đang Active và chưa được cấp quyền Project đó.
              </p>
            </div>
          </article>
          <article>
            <span>02</span>
            <div>
              <strong>Editor không có Team để chọn</strong>
              <p>
                Tạo hoặc kích hoạt Team trước. Editor cần ít nhất một Team Active trong Project.
              </p>
            </div>
          </article>
          <article>
            <span>03</span>
            <div>
              <strong>Đã thêm vào Team nhưng vẫn không vào được Project</strong>
              <p>
                Team membership không cấp Project Access. Quay lại Users & Permissions và cấp Admin
                hoặc Editor phù hợp.
              </p>
            </div>
          </article>
          <article>
            <span>05</span>
            <div>
              <strong>Không đổi hoặc xóa được dòng Workspace Admin</strong>
              <p>
                Đây là dòng quyền hệ thống, chỉ dùng để nhận biết. Không cấp thêm Admin/Editor cho
                cùng Project.
              </p>
            </div>
          </article>
          <article>
            <span>06</span>
            <div>
              <strong>Workspace Admin không xuất hiện trong Owner</strong>
              <p>
                Thêm họ làm thành viên Active của Team đang chọn. Quyền Workspace Admin cho phép tạo
                US/DE nhưng không tự làm tên xuất hiện trong danh sách Owner.
              </p>
            </div>
          </article>
          <article>
            <span>07</span>
            <div>
              <strong>Project owner không có quyền quản lý</strong>
              <p>
                Project owner là metadata. Cấp Admin hoặc Editor riêng nếu người đó cần truy cập hệ
                thống.
              </p>
            </div>
          </article>
          <article>
            <span>08</span>
            <div>
              <strong>Quyền vừa đổi nhưng giao diện chưa cập nhật</strong>
              <p>
                Tải lại trang, kiểm tra request tiếp theo và chọn lại Project/Team trong context
                selector.
              </p>
            </div>
          </article>
          <article>
            <span>09</span>
            <div>
              <strong>Không Archive hoặc Delete được Project</strong>
              <p>
                Đọc thông báo phụ thuộc và bước xác nhận. Dùng Archive khi cần giữ lịch sử và chỉ
                Delete khi dữ liệu thực sự được phép xóa.
              </p>
            </div>
          </article>
        </TroubleshootList>
      </Section>
      <CheckUnderstanding>
        <strong>Tự kiểm tra trước khi sang phần tiếp theo</strong>
        <ul>
          <li>Bạn phân biệt quyền Project với thành viên Team chưa?</li>
          <li>Bạn biết Admin và Editor khác nhau ở phạm vi Team chưa?</li>
          <li>Bạn biết vì sao Workspace Admin không có nút đổi Access Level chưa?</li>
          <li>Bạn biết dùng Audit Log để đối chiếu thay đổi chưa?</li>
        </ul>
      </CheckUnderstanding>
    </>
  )
}
